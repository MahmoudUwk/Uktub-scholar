/**
 * Adopted verification strategy (A/B 2026-10-15): the hosted engine judges
 * the top-10 retrieval candidates per claim by default; every other engine
 * stays exhaustive. `UKTUB_VERIFY_STRATEGY=exhaustive|top10` overrides the
 * hosted default (consumers: benchmark/study runs). Offline: fake engine,
 * stub fetch, real SQLite.
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
import { EngineError, systemoneEndpointEngine } from "../src/core/verify/claim.ts";
import { criteriaQuestion } from "../src/core/verify/wording.ts";
import { chunksOf, publishSource } from "../src/core/verify/store.ts";
import {
  TOP_K,
  verifySwitchFromEnv,
} from "../src/core/verify/strategy.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const CLAIM = "Cells age faster at high temperature in the tested cells.";
const MARK = "cells age faster at high temperature";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vs-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

// ── fixtures ───────────────────────────────────────────────────────────────

const filler = (tag: string): string => `${tag} The experiment records many independent measurements of the cell culture growth rate. `;
const SUPPORT = "Experiments show that cells age faster at high temperature than at room temperature, with capacity loss reaching twelve percent.";
/** 30 paragraphs (~150 chars each); the marker sentence sits in paragraph `at`. */
function paperText(tag: string, at: number | null): string {
  return Array.from({ length: 30 }, (_, i) => (i === at ? `${filler(`${tag}-p${i}`)}${SUPPORT}` : filler(`${tag}-p${i}`))).join("\n\n");
}

let digestN = 0;
function addPaper(doi: string, text: string): void {
  registerPaper(db, { doi, title: doi, authors: ["Holder, Ada"], year: 2024, bibtex: BIB, bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 1.0, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi}.pdf`, license: null, digest: String(++digestN).padStart(64, "0"), extraction: "t@1", text, pageStarts: [0] }, cfg, NOW());
}

function writeConfig(engine = "hosted"): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 1.0\n  boundary: paragraph\nverification:\n  engine: ${engine}\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: 100000\n`,
  );
}

/** Scores 0.999 for rows whose passage carries the marker and the right claim; 0.05 otherwise. */
function engine(seen: { state: string; instructions: string }[] = []): VerifyHooks {
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
const text = (r: { content: { text: string }[] }): string => r.content.map((c) => c.text).join("\n");

// ── env parsing ────────────────────────────────────────────────────────────

describe("verify strategy from the environment (hosted top10 by default)", () => {
  it("hosted defaults to top10; exhaustive and top10 are honored, junk falls back to top10", () => {
    assert.equal(verifySwitchFromEnv({}, "hosted"), "top10");
    assert.equal(verifySwitchFromEnv({ UKTUB_VERIFY_STRATEGY: "exhaustive" }, "hosted"), "exhaustive");
    assert.equal(verifySwitchFromEnv({ UKTUB_VERIFY_STRATEGY: "top10" }, "hosted"), "top10");
    assert.equal(verifySwitchFromEnv({ UKTUB_VERIFY_STRATEGY: "bogus" }, "hosted"), "top10");
    assert.equal(verifySwitchFromEnv({ UKTUB_VERIFY_STRATEGY: " exhaustive " }, "hosted"), "exhaustive");
  });

  it("non-hosted engines always run exhaustive", () => {
    for (const e of ["eos", "eos-onnx", "openrouter", "llama-cpp"]) {
      assert.equal(verifySwitchFromEnv({ UKTUB_VERIFY_STRATEGY: "top10" }, e), "exhaustive", e);
      assert.equal(verifySwitchFromEnv({}, e), "exhaustive", e);
    }
  });
});

// ── adapter: one question per request ───────────────────────────────────────

interface Seen {
  body: Record<string, unknown>;
}
const stubFetch = (seen: Seen[], scores: Record<string, number> = {}) =>
  (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    seen.push({ body });
    const questions = body.questions as Record<string, { instructions: string }>;
    const answers: Record<string, { noul: number }> = {};
    for (const [k, q] of Object.entries(questions)) answers[k] = { noul: scores[q.instructions] ?? 0.5 };
    return new Response(JSON.stringify({ answers }), { status: 200 });
  }) as unknown as typeof fetch;

describe("systemone adapter: one question per request", () => {
  const URL = "https://decision.vllm-sr.ai/v1/systemone";

  it("keeps the one-question shape", async () => {
    const seen: Seen[] = [];
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: stubFetch(seen) });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.5]);
    assert.deepEqual(Object.keys((seen[0]!.body.questions ?? {}) as object), ["c"]);
    assert.deepEqual((seen[0]!.body.questions as Record<string, unknown>).c, criteriaQuestion("c", "criteria"));
  });

  it("same-state rows travel as separate one-question requests, in order", async () => {
    const seen: Seen[] = [];
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: stubFetch(seen) });
    const out = await e.run([
      { state: "S", instructions: "q0" },
      { state: "S", instructions: "q1" },
      { state: "OTHER", instructions: "q2" },
    ]);
    assert.deepEqual(out, [0.5, 0.5, 0.5]);
    assert.equal(seen.length, 3);
    for (const s of seen) assert.deepEqual(Object.keys((s.body.questions ?? {}) as object), ["c"]);
    assert.equal(seen[0]!.body.state, "S");
    assert.equal(seen[2]!.body.state, "OTHER");
  });

  it("a missing or invalid answer is an engine failure, never a score", async () => {
    const bad = (async () => new Response(JSON.stringify({ answers: {} }), { status: 200 })) as unknown as typeof fetch;
    const e = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl: bad });
    await assert.rejects(e.run([{ state: "S", instructions: "a" }]), (err) => err instanceof EngineError);
  });
});

// ── workflow strategies ────────────────────────────────────────────────────

describe("workflow candidate strategies", () => {
  beforeEach(() => {
    addPaper("10.1111/aaa", paperText("A", 7));
    addPaper("10.1111/bbb", paperText("B", null));
    writeConfig("hosted");
  });

  const chunksTotal = (): number => chunksOf(db, "10.1111/aaa").length + chunksOf(db, "10.1111/bbb").length;

  it("hosted defaults to top10: at most 10 chunks, candidate-limited, never exhaustive", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const r = await verifyClaimTool(ctx(), { claim: CLAIM, papers: "all" } as VerifyClaimArgs, engine(seen));
    assert.ok(chunksTotal() > TOP_K, `fixture needs > ${TOP_K} chunks, has ${chunksTotal()}`);
    assert.ok(S(r).coverage.candidates.total <= TOP_K, `judged ${S(r).coverage.candidates.total}`);
    assert.equal(S(r).result.searched, "candidate_limited");
    assert.ok((S(r).result.limitations as string[]).includes("candidate_limited"));
    assert.equal(S(r).result.complete, false);
    assert.equal(S(r).result.supportFound, true, "the marker chunk ranks top");
    assert.match(text(r), /candidate-limited/);
    assert.ok(!text(r).includes("candidates: exhaustive"), "never claims exhaustive");
    assert.match(text(r), /top retrieval candidates checked/, "coverage names the top candidates checked");
  });

  it("UKTUB_VERIFY_STRATEGY=exhaustive restores the exhaustive pass on hosted", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const r = await verifyClaimTool(ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }), { claim: CLAIM, papers: "all" } as VerifyClaimArgs, engine(seen));
    assert.ok(chunksTotal() > TOP_K, `fixture needs > ${TOP_K} chunks, has ${chunksTotal()}`);
    assert.equal(S(r).result.searched, "exhaustive");
    assert.equal(S(r).coverage.candidates.total, chunksTotal());
    assert.equal(S(r).result.complete, true);
    assert.equal(S(r).result.supportFound, true);
  });

  it("a locator query keeps query-limited behavior under any strategy", async () => {
    const r = await verifyClaimTool(ctx({ UKTUB_VERIFY_STRATEGY: "exhaustive" }), { claim: CLAIM, papers: "all", query: "cells temperature" } as VerifyClaimArgs, engine());
    assert.equal(S(r).result.searched, "query_limited");
  });

  it("a non-hosted engine ignores the switch", async () => {
    writeConfig("llama-cpp");
    const r = await verifyClaimTool(ctx({ UKTUB_VERIFY_STRATEGY: "top10" }), { claim: CLAIM, papers: "all" } as VerifyClaimArgs, engine());
    assert.equal(S(r).result.searched, "exhaustive");
    assert.equal(S(r).coverage.candidates.total, chunksTotal());
  });

  it("a claim with no searchable words falls back to exhaustive", async () => {
    const seen: { state: string; instructions: string }[] = [];
    const r = await verifyClaimTool(ctx(), { claim: "........ ........", papers: "all" } as VerifyClaimArgs, engine(seen));
    assert.equal(S(r).result.searched, "exhaustive");
    assert.equal(seen.length, chunksTotal());
  });
});
