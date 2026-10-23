/**
 * Continuation integrity: a run freezes its candidate list at creation and a
 * continuation replays that list — it never re-ranks, and a changed strategy,
 * protocol, or missing candidate refuses instead of silently shifting work.
 * Offline: fake engine, stub fetch, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { verifyClaimTool, type VerifyClaimArgs, type VerifyHooks } from "../src/core/tools/verify.ts";
import { chunksOf, publishSource } from "../src/core/verify/store.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const CLAIM = "Cells age faster at high temperature in the tested cells.";
const MARK = "cells age faster at high temperature";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vci-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── fixtures ───────────────────────────────────────────────────────────────

const filler = (tag: string): string => `${tag} The experiment records many independent measurements of the cell culture growth rate. `;
const SUPPORT = "Experiments show that cells age faster at high temperature than at room temperature, with capacity loss reaching twelve percent.";
function paperText(tag: string, at: number | null): string {
  return Array.from({ length: 30 }, (_, i) => (i === at ? `${filler(`${tag}-p${i}`)}${SUPPORT}` : filler(`${tag}-p${i}`))).join("\n\n");
}

let digestN = 0;
function addPaper(doi: string, text: string): void {
  registerPaper(db, { doi, title: doi, authors: ["Holder, Ada"], year: 2024, bibtex: BIB, bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1.0, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi}.pdf`, license: null, digest: String(++digestN).padStart(64, "0"), extraction: "t@1", text, pageStarts: [0] }, cfg, NOW());
}

function writeConfig(maxJudgments: number): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 1.0\n  boundary: paragraph\nverification:\n  engine: hosted\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: ${maxJudgments}\n`,
  );
}

function hooks(seen: { state: string; instructions: string }[]): VerifyHooks {
  return {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (rows) => {
        seen.push(...rows);
        return rows.map((r) => (r.state.toLowerCase().includes(MARK) && r.instructions === CLAIM ? 0.999 : 0.05));
      },
    }),
  };
}

function ctx(env: Record<string, string | undefined> = {}): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network");
    }) as ToolContext["fetch"],
    env: { UKTUB_VERIFY_MODEL_ID: "test-model", ...env },
    now: NOW,
    queue: new WriteQueue(),
  };
}
const S = (r: { structuredContent: unknown }) => r.structuredContent as Record<string, any>;
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;
const run = (args: VerifyClaimArgs, h: VerifyHooks, c: ToolContext) => verifyClaimTool(c, args, h);
const decodeToken = (t: string): { v?: number; r?: unknown } => JSON.parse(Buffer.from(t, "base64url").toString("utf8"));
const snapshotOf = (runId: string): Record<string, any> =>
  JSON.parse((db.prepare("SELECT snapshot_json AS j FROM verify_runs WHERE run_id = ?").get(runId) as { j: string }).j);
const rewriteSnapshot = (runId: string, snap: Record<string, any>): void => {
  db.prepare("UPDATE verify_runs SET snapshot_json = ? WHERE run_id = ?").run(JSON.stringify(snap), runId);
};

// ── strategy switches refuse ─────────────────────────────────────────────

describe("continuation integrity: frozen candidates", () => {
  beforeEach(() => {
    digestN = 0;
    addPaper("10.1111/aaa", paperText("A", 7));
    addPaper("10.1111/bbb", paperText("B", null));
    writeConfig(3);
  });

  it("top10 -> exhaustive is refused before any new judgment", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const token = S(first).continuation as string;
    assert.ok(token, "first call must interrupt with a continuation");
    assert.equal(S(first).result.searched, "candidate_limited");
    const judgedBefore = seen.length;
    assert.equal(judgedBefore, 3);
    const second = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }));
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, judgedBefore, "refusal judges nothing new");
  });

  it("exhaustive -> top10 is refused before any new judgment", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }));
    const token = S(first).continuation as string;
    assert.ok(token);
    assert.equal(S(first).result.searched, "exhaustive");
    const judgedBefore = seen.length;
    const second = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, judgedBefore, "refusal judges nothing new");
  });

  it("an unchanged top10 continuation judges exactly the frozen candidates", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const counts: number[] = [];
    const totals: number[] = [];
    let r = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const firstToken = S(r).continuation as string;
    let token: string | null = firstToken;
    assert.ok(token);
    counts.push(seen.length);
    totals.push(S(r).coverage.candidates.total);
    let guard = 0;
    while (token !== null && guard++ < 10) {
      const before = seen.length;
      r = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
      assert.equal(refused(r), undefined);
      assert.equal(S(r).result.searched, "candidate_limited");
      counts.push(seen.length - before);
      totals.push(S(r).coverage.candidates.total);
      token = S(r).continuation;
    }
    assert.equal(token, null, "work finishes");
    assert.deepEqual(counts, [3, 3, 3, 1], "exactly 10 frozen candidates judged once each");
    assert.ok(totals.every((t) => t === 10), `every page reports the frozen 10, saw ${totals}`);
    assert.equal(new Set(seen.map((s) => s.state)).size, 10, "no candidate judged twice, none skipped");
    assert.equal(S(r).result.complete, false, "a limited check never reports complete");
    const { r: runId } = decodeToken(firstToken);
    const ids = snapshotOf(runId as string).candidateIds as unknown;
    assert.ok(Array.isArray(ids) && ids.length === 10 && ids.every((id) => typeof id === "string"), "the run freezes its 10 candidates at creation");
    const sel = db.prepare("SELECT text AS t FROM chunks WHERE chunk_id = ?");
    const frozen = (ids as string[]).map((id) => (sel.get(id) as { t: string }).t);
    assert.deepEqual(seen.map((s) => s.state), frozen, "continuations visit the captured candidates in captured order");
  });

  it("adding an unrelated ready paper cannot reorder a top10 continuation", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const firstToken = S(first).continuation as string;
    let token: string | null = firstToken;
    assert.ok(token);
    addPaper("10.1111/ccc", paperText("C", 0));
    assert.ok(chunksOf(db, "10.1111/ccc").length > 0);
    let guard = 0;
    let last = first;
    const counts: number[] = [seen.length];
    const doisOf = (resp: { structuredContent: unknown }): string[] =>
      (S(resp).coverage.candidates.perPaper as { doi: string }[]).map((p) => p.doi);
    while (token !== null && guard++ < 10) {
      const before = seen.length;
      last = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
      assert.equal(refused(last), undefined, "the new paper must not break the frozen run");
      assert.equal(S(last).coverage.candidates.total, 10);
      assert.equal(S(last).result.searched, "candidate_limited");
      assert.deepEqual(doisOf(last), ["10.1111/aaa", "10.1111/bbb"], "coverage stays frozen to the run's papers");
      counts.push(seen.length - before);
      token = S(last).continuation;
    }
    assert.equal(token, null);
    assert.deepEqual(counts, [3, 3, 3, 1], "the frozen 10 are judged once each despite the new paper");
    const { r: runId } = decodeToken(firstToken);
    const ids = snapshotOf(runId as string).candidateIds as unknown;
    assert.ok(Array.isArray(ids) && ids.length === 10, "candidates were frozen at creation, before the paper was added");
    assert.equal(new Set(seen.map((s) => s.state)).size, 10);
    assert.ok(seen.every((s) => !s.state.includes("C-p")), "the added paper is never judged in this run");
  });

  it("a protocol mismatch is refused before any new judgment", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const token = S(first).continuation as string;
    assert.ok(token);
    const { r: runId } = decodeToken(token);
    const snap = snapshotOf(runId as string);
    snap.protocol = "tampered-protocol-v9";
    rewriteSnapshot(runId as string, snap);
    const judgedBefore = seen.length;
    const second = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, judgedBefore, "refusal judges nothing new");
  });

  it("a legacy v2 token is refused", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const token = S(first).continuation as string;
    assert.ok(token);
    const { r: runId } = decodeToken(token);
    const legacy = Buffer.from(JSON.stringify({ v: 2, r: runId })).toString("base64url");
    const second = await run({ claim: CLAIM, papers: "all", continuation: legacy } as VerifyClaimArgs, h, ctx());
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, 3, "refusal judges nothing new");
  });

  it("a missing saved candidate is refused, not skipped", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const token = S(first).continuation as string;
    assert.ok(token);
    const { r: runId } = decodeToken(token);
    const ids = snapshotOf(runId as string).candidateIds as string[];
    assert.ok(Array.isArray(ids) && ids.length === 10, "the run freezes its 10 candidates");
    db.prepare("DELETE FROM chunks WHERE chunk_id = ?").run(ids[0]);
    const judgedBefore = seen.length;
    const second = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, judgedBefore, "refusal judges nothing new");
  });

  it("malformed saved candidates are refused conservatively", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const first = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx());
    const token = S(first).continuation as string;
    assert.ok(token);
    const { r: runId } = decodeToken(token);
    const snap = snapshotOf(runId as string);
    snap.candidateIds = [42, null, ""];
    rewriteSnapshot(runId as string, snap);
    const judgedBefore = seen.length;
    const second = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx());
    assert.equal(refused(second), "CONTINUATION_INVALID");
    assert.equal(seen.length, judgedBefore, "refusal judges nothing new");
  });

  it("query mode ignores the strategy override across continuation", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    let r = await run({ claim: CLAIM, papers: "all", query: "cell culture growth" } as VerifyClaimArgs, h, ctx());
    assert.equal(S(r).result.searched, "query_limited");
    let token: string | null = S(r).continuation;
    assert.ok(token, "query results page under a budget of 3");
    let guard = 0;
    while (token !== null && guard++ < 10) {
      r = await run({ claim: CLAIM, papers: "all", query: "cell culture growth", continuation: token } as VerifyClaimArgs, h, ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }));
      assert.equal(refused(r), undefined, "query mode never applies the strategy switch");
      assert.equal(S(r).result.searched, "query_limited");
      token = S(r).continuation;
    }
    assert.equal(token, null);
  });

  it("exhaustive multi-call behavior is unchanged", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const h = hooks(seen);
    const total = chunksOf(db, "10.1111/aaa").length + chunksOf(db, "10.1111/bbb").length;
    assert.ok(total > 10, `fixture needs > 10 chunks, has ${total}`);
    let r = await run({ claim: CLAIM, papers: "all" } as VerifyClaimArgs, h, ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }));
    let token: string | null = S(r).continuation;
    let guard = 0;
    while (token !== null && guard++ < 10) {
      r = await run({ claim: CLAIM, papers: "all", continuation: token } as VerifyClaimArgs, h, ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }));
      assert.equal(refused(r), undefined);
      assert.equal(S(r).result.searched, "exhaustive");
      token = S(r).continuation;
    }
    assert.equal(token, null);
    assert.equal(S(r).coverage.candidates.total, total);
    assert.equal(S(r).result.complete, true);
    assert.deepEqual(S(r).result.limitations, []);
    assert.equal(new Set(seen.map((s) => s.state)).size, total, "every chunk judged exactly once");
  });
});
