/**
 * Phase V5a: document mode bundled per paper, every cited paper must support.
 * Offline: fake engine via hooks (logging every run), invented fixture text,
 * real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { Value } from "typebox/value";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { VerifyDocumentOutput, verifyClaimTool, type VerifyArgs, type VerifyHooks } from "../src/core/tools/verify.ts";
import type { SectionMark } from "../src/core/sections.ts";
import { publishSource, resolvePointer } from "../src/core/verify/store.ts";

const NOW = () => new Date("2026-10-04T12:00:00Z");
const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
const UNITS_ENV = { UKTUB_VERIFY_MODEL_ID: "test-model", UKTUB_VERIFY_STRATEGY: "units" };

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-vd5-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const filler = (tag: string, n: number): string => `${tag} ` + "The experiment records many independent measurements of the cell. ".repeat(Math.ceil(n / 65)).slice(0, n);

function sectionedPaper(sections: [string, string][]): { text: string; marks: SectionMark[] } {
  const parts: string[] = [];
  const marks: SectionMark[] = [];
  let off = 0;
  sections.forEach(([heading, body], i) => {
    if (i > 0) {
      parts.push("\n\n");
      off += 2;
    }
    marks.push({ start: off, heading, level: 1 });
    const chunk = `${heading}\n\n${body}`;
    parts.push(chunk);
    off += chunk.length;
  });
  return { text: parts.join(""), marks };
}

const sectionSpan = (text: string, marks: SectionMark[], i: number): [number, number] => [
  marks[i].start,
  i + 1 < marks.length ? marks[i + 1].start : text.length,
];

function addPaper(doi: string, title: string, text: string, marks?: SectionMark[]): void {
  registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", `${doi.slice(-3)},`), bibtexSource: "crossref" }, { now: NOW });
  const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
  publishSource(db, doi, { kind: "local-file", ref: `${doi.slice(-3)}.pdf`, license: null, digest: `${doi.length}${doi}`.padStart(64, "0"), extraction: "t@1", text, pageStarts: [0], ...(marks === undefined ? {} : { sections: marks }) }, cfg, NOW());
}

function writeConfig(opts: { maxJudgments?: number; workers?: number; engine?: string } = {}): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(
    join(root, "config", "chunking.yaml"),
    `chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: paragraph\nverification:\n  engine: ${opts.engine ?? "llama-cpp"}\n  min_confidence: 0.99\n  workers: ${opts.workers ?? 2}\n  max_judgments: ${opts.maxJudgments ?? 120}\n`,
  );
}

type Scorer = (row: { state: string; instructions: string }) => number | { failed: string };

function engine(score: Scorer): { hooks: VerifyHooks; calls: { state: string; instructions: string }[][] } {
  const calls: { state: string; instructions: string }[][] = [];
  const hooks: VerifyHooks = {
    fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
    createEngine: () => ({
      run: async (rows) => {
        calls.push(rows.map((r) => ({ state: r.state, instructions: r.instructions })));
        return rows.map(score);
      },
    }),
  };
  return { hooks, calls };
}

function ctx(over: Partial<ToolContext> = {}): ToolContext {
  return {
    root,
    fetch: (async () => {
      throw new Error("no network");
    }) as ToolContext["fetch"],
    env: UNITS_ENV,
    now: NOW,
    queue: new WriteQueue(),
    ...over,
  };
}
type Doc = Record<string, any>;
const S = (r: { structuredContent: unknown }): Doc => r.structuredContent as Doc;
const unitsOf = (s: Doc): Doc[] => s.units as Doc[];
const refused = (r: { details: Record<string, unknown> }): string | undefined => (r.details.refused as { code?: string } | undefined)?.code;
const cite = (k: string): string => `\\cite{${k}}`;
const keysOf = (doi: string): string => (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;

const ALPHA = "alpha finding holds in the tested cells";
const byAlpha: Scorer = (r) => (r.state.toLowerCase().includes("alpha") && r.instructions.toLowerCase().includes("alpha") ? 0.999 : 0.05);

function alphaPaper(doi: string, title: string, withMark: boolean): void {
  const { text, marks } = sectionedPaper([
    ["Background", filler("bg", 400)],
    ["Results", withMark ? `${filler("re", 300)}\n\nAlpha finding holds in the tested cells with scatter below twelve percent.\n\n${filler("re-b", 300)}` : filler("re", 700)],
  ]);
  addPaper(doi, title, text, marks);
}

describe("V5a prime and replay", () => {
  it("T5.1 6 claims citing one paper with 2 units -> ONE bundle: one 12-row call, instructions are the unit plains", async () => {
    const { text, marks } = sectionedPaper([
      ["First", `${filler("u1", 300)}\n\nSharedmark section one states the sharedmark result plainly.\n\n${filler("u1-b", 300)}`],
      ["Second", filler("u2", 700)],
    ]);
    addPaper("10.1111/t51a", "One Paper", text, marks);
    writeConfig({ engine: "hosted" });
    const kp = keysOf("10.1111/t51a");
    const sentences = [
      `Sharedmark result number one holds ${cite(kp)}.`,
      `Sharedmark result number two holds ${cite(kp)}.`,
      `Sharedmark result number three holds ${cite(kp)}.`,
      `Other result number four holds ${cite(kp)}.`,
      `Other result number five holds ${cite(kp)}.`,
      `Other result number six holds ${cite(kp)}.`,
    ];
    const frag = `\\section{S}\n${sentences.join("\n")}\n`;
    const { hooks, calls } = engine((r) => (r.state.includes("Sharedmark") && r.instructions.includes("Sharedmark") ? 0.999 : 0.05));
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    const big = calls.filter((rows) => rows.length === 12);
    assert.equal(big.length, 1, `expected exactly one 12-row round-1 call, got ${calls.map((rows) => rows.length)}`);
    const plains = unitsOf(s).map((u) => u.excerpt as string);
    assert.deepEqual(big[0].map((row) => row.instructions), [...plains, ...plains]);
    const states = [...new Set(big[0].map((row) => row.state))];
    assert.equal(states.length, 2);
    for (const k of [0, 1]) {
      const [a, b] = sectionSpan(text, marks, k);
      assert.ok(states.includes(text.slice(a, b)), `unit ${k} slice never sent`);
    }
  });

  it("T5.2 every cited paper must support", async () => {
    alphaPaper("10.1111/t52a", "Paper A", true);
    alphaPaper("10.1111/t52b", "Paper B", false);
    const ka = keysOf("10.1111/t52a");
    const kb = keysOf("10.1111/t52b");
    writeConfig();
    const frag = (citeA: string, citeB: string): string => `\\section{S}\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} with care ${cite(citeA)}${citeB === "" ? "" : ` ${cite(citeB)}`} about nothing else at all here.\n`;
    const onlyA = async (): Promise<Doc> => {
      const { hooks } = engine(byAlpha);
      const r = await verifyClaimTool(ctx(), { text: frag(ka, kb) } as VerifyArgs, hooks);
      assert.equal(refused(r), undefined);
      return S(r);
    };
    const s = await onlyA();
    const u = unitsOf(s)[0];
    assert.equal(u.status, "cited-unsupported");
    assert.deepEqual(u.failedCites, [kb]);
    assert.ok((u.pointers as string[]).length > 0, "supporting cite's pointer present");
    assert.ok(!(u.failedCites as string[]).includes(ka));

    alphaPaper("10.1111/t52c", "Paper C", true);
    const kc = keysOf("10.1111/t52c");
    const { hooks } = engine(byAlpha);
    const both = await verifyClaimTool(ctx(), { text: frag(ka, kc) } as VerifyArgs, hooks);
    assert.equal(refused(both), undefined);
    const sb = S(both);
    const ub = unitsOf(sb)[0];
    assert.equal(ub.status, "supported");
    assert.equal(ub.failedCites, undefined);
    assert.ok((ub.pointers as string[]).length >= 2, "both supporting papers leave pointers");
  });

  it("T5.3 unregistered and sourceless cites never support", async () => {
    alphaPaper("10.1111/t53a", "Good Paper", true);
    const ka = keysOf("10.1111/t53a");
    registerPaper(db, { doi: "10.1111/t53b", title: "Sourceless", authors: ["Holder, Ada"], year: 2024, bibtex: BIB, bibtexSource: "crossref" }, { now: NOW });
    const kb = keysOf("10.1111/t53b");
    writeConfig();
    const { hooks } = engine(byAlpha);
    // No support anywhere: the claim names content no paper states, so the recheck finds nothing.
    const lone = await verifyClaimTool(ctx(), { text: `\\section{S}\nThe zeta-only calibration behaves as expected today ${cite(kb)}.\n` } as VerifyArgs, hooks);
    assert.equal(refused(lone), undefined);
    const sl = S(lone);
    assert.equal(unitsOf(sl)[0].status, "cited-unsupported");
    assert.deepEqual(unitsOf(sl)[0].failedCites, [kb]);
    assert.equal(unitsOf(sl)[0].complete, false);

    const { hooks: hooks2 } = engine(byAlpha);
    const mixed = await verifyClaimTool(ctx(), { text: `\\section{S}\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} today ${cite(ka)} ${cite("nosuchkey")}.\n` } as VerifyArgs, hooks2);
    assert.equal(refused(mixed), undefined);
    const sm = S(mixed);
    assert.equal(unitsOf(sm)[0].status, "cited-unsupported");
    // Only the unknown key failed: the registered cite supports the claim.
    assert.deepEqual(unitsOf(sm)[0].failedCites, ["nosuchkey"]);
    assert.ok((unitsOf(sm)[0].unregistered as string[]).includes("nosuchkey"));
  });

  it("T5.4 a unit citing only unknown keys stays unregistered", async () => {
    alphaPaper("10.1111/t54a", "Paper", true);
    writeConfig();
    const { hooks } = engine(byAlpha);
    const r = await verifyClaimTool(ctx(), { text: `\\section{S}\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} today ${cite("nosuchkey")}.\n` } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    assert.equal(unitsOf(S(r))[0].status, "unregistered");
  });

  it("T5.5 one paper fails while the other is fine; all failing refuses", async () => {
    const { text: textA, marks: marksA } = sectionedPaper([
      ["Background", filler("fa-bg", 400)],
      ["Results", `${filler("fa-re", 300)}\n\nAlpha finding holds in the tested cells with care.\n\n${filler("fa-re-b", 300)}`],
    ]);
    addPaper("10.1111/t55a", "Paper A", textA, marksA);
    const { text: textB, marks: marksB } = sectionedPaper([
      ["Background", filler("fb-bg", 400)],
      ["Results", `${filler("fb-re", 300)}\n\nAlpha finding repeats across the control samples.\n\n${filler("fb-re-b", 300)}`],
    ]);
    addPaper("10.1111/t55b", "Paper B", textB, marksB);
    // The fixture's A0 path refuses the page: every row touching A's text throws.
    const failing = (marker: string): Scorer => (row) => {
      if (row.state.includes(marker)) throw new Error("paper A is down");
      return byAlpha(row);
    };
    const ka = keysOf("10.1111/t55a");
    const kb = keysOf("10.1111/t55b");
    writeConfig({ engine: "hosted" });
    const frag =
      `\\section{S}\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} first ${cite(ka)}.\n` + `${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} second ${cite(kb)}.\n`;
    const { hooks } = engine(failing("Alpha finding holds in the tested cells with care"));
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    const [ua, ub] = unitsOf(s);
    assert.equal(ub.status, "supported");
    assert.equal(ub.complete, true);
    assert.equal(ua.status, "cited-unsupported");
    assert.equal(ua.complete, false);
    assert.equal(s.summary.incomplete, 1);

    const { hooks: doomed } = engine(() => {
      throw new Error("down");
    });
    // A truly all-failing page: drop the compute cache the first half wrote.
    db.prepare("DELETE FROM claim_judgments").run();
    const r2 = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, doomed);
    assert.equal(refused(r2), "VERIFY_ENGINE_MISSING");
  });

  it("T5.6 two claims supported at the same unit share window calls", async () => {
    const { text, marks } = sectionedPaper([
      ["Background", filler("w6-bg", 400)],
      ["Results", `${filler("w6-0", 700)}\n\nSharedmark window finding holds here with care taken.\n\n${filler("w6-1", 700)}\n\n${filler("w6-2", 700)}`],
    ]);
    const [rs, re] = sectionSpan(text, marks, 1);
    assert.ok(re - rs > 1_500, "support unit spans windows");
    addPaper("10.1111/t56a", "Wide Paper", text, marks);
    writeConfig({ engine: "hosted" });
    const kp = keysOf("10.1111/t56a");
    const frag = `\\section{S}\nSharedmark window finding holds here first ${cite(kp)}.\nSharedmark window finding holds here second ${cite(kp)}.\n`;
    const { hooks, calls } = engine((row) => (row.state.includes("Sharedmark") && row.instructions.includes("Sharedmark") ? 0.999 : 0.05));
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.deepEqual(
      unitsOf(s).map((u) => u.status),
      ["supported", "supported"],
    );
    const shared = calls.filter((rows) => rows.length === 6 && new Set(rows.map((x) => x.instructions)).size === 2);
    assert.equal(shared.length, 1, `expected one shared window call, got ${calls.map((rows) => rows.length)}`);
    assert.ok(shared[0].every((row) => row.state.length <= 1_500));
    assert.ok(shared[0].every((row) => text.includes(row.state)));
  });

  it("T5.7 ledger text is the unit plain, ledger covers every supporting cite, pointers resolve", async () => {
    alphaPaper("10.1111/t57a", "Paper A", true);
    alphaPaper("10.1111/t57b", "Paper B", true);
    const ka = keysOf("10.1111/t57a");
    const kb = keysOf("10.1111/t57b");
    writeConfig();
    const { hooks } = engine(byAlpha);
    const plain = `${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} today ${cite(ka)} ${cite(kb)}.`;
    const r = await verifyClaimTool(ctx(), { text: `\\section{S}\n${plain}\n` } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    const u = unitsOf(s)[0];
    assert.equal(u.status, "supported");
    const ledger = db.prepare("SELECT doi FROM claim_ledger WHERE claim_text = ?").all(u.excerpt) as { doi: string }[];
    assert.deepEqual(new Set(ledger.map((row) => row.doi)), new Set(["10.1111/t57a", "10.1111/t57b"]));
    for (const p of u.pointers as string[]) {
      const resolved = resolvePointer(db, p);
      assert.equal(resolved.status, "current", `${p} does not resolve`);
    }
  });

  it("T5.8 single-cite manuscript parity with A0 except every-cited-paper effects", async () => {
    const TEMP = "Cells age faster at high temperature than at room temperature";
    const CHEESE = "The moon is made of green cheese";
    const BERLIN_A = "10.1111/berlin-a";
    const BERLIN_B = "10.1111/berlin-b";
    const paper = (paras: string[]): string => paras.join("\n\n");
    const add = (doi: string, title: string, paras: string[]): string => {
      registerPaper(db, { doi, title, authors: ["Holder, Ada"], year: 2024, bibtex: BIB, bibtexSource: "crossref" }, { now: NOW });
      const cfg = { chunk_tokens: 256, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const };
      publishSource(db, doi, { kind: "local-file", ref: "r.pdf", license: null, digest: doi.padStart(64, "0"), extraction: "t@1", text: paper(paras), pageStarts: [0] }, cfg, NOW());
      return (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
    };
    const ka = add(BERLIN_A, "Berlin A", ["Filler paragraph about measurement methods used in the laboratory.", `${TEMP} (markone alpha).`, "Another filler paragraph about calibration of the instruments."]);
    const kb = add(BERLIN_B, "Berlin B", ["Filler paragraph about unrelated control software.", "More filler about scheduling and logging."]);
    writeConfig();
    const hooks: VerifyHooks = {
      fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
      createEngine: () => ({
        run: async (rows) => rows.map((x) => (x.state.includes("markone") && x.instructions.includes("high temperature") ? 0.999 : 0.05)),
      }),
    };
    const manuscript = [`\\section{Background}`, `${TEMP} ${cite(ka)}.`, `${CHEESE} ${cite(ka)}.`, `${TEMP}.`, `${CHEESE}.`, `${TEMP} ${cite(kb)}.`, `A claim with an unknown key ${cite("nosuchkey")}.`, ""].join("\n");
    const r = await verifyClaimTool(ctx(), { text: manuscript } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.ok(Value.Check(VerifyDocumentOutput, s), "document output matches its schema");
    assert.deepEqual(
      unitsOf(s).map((u) => u.status),
      ["supported", "cited-unsupported", "missing-citation", "unsourced", "missing-citation", "unregistered"],
    );
    assert.deepEqual(unitsOf(s)[1].failedCites, [ka]);
    assert.equal(s.summary.supported, 1);
  });

  it("T5.9 page budget: max_judgments x claims bounds prime rows, page stays incomplete instead of refusing", async () => {
    const { text, marks } = sectionedPaper(
      Array.from({ length: 3 }, (_, i) => [`Part ${i + 1}`, `${filler(`q${i}`, 900)}\n\n${filler(`q${i}-b`, 200)}`] as [string, string]),
    );
    void marks;
    addPaper("10.1111/t59a", "Paged Paper", text, marks);
    writeConfig({ maxJudgments: 1 });
    const kp = keysOf("10.1111/t59a");
    const frag = `\\section{S}\n${[1, 2, 3].map((i) => `The control samples behave as expected number ${i} ${cite(kp)}.`).join("\n")}\n`;
    const { hooks, calls } = engine(byAlpha);
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    // 3 claims x 3 units, max_judgments 1: round 1 judges U1 x all claims in
    // one call; round 2 judges the first recheck cells, skipping the cells
    // round 1 cached; per-claim runs serve the prime and spend nothing.
    assert.deepEqual(
      calls.map((rows) => rows.length),
      [3, 2, 1],
    );
    // Claim 1 is fully judged (U1 in round 1, U2/U3 in its round-2 recheck);
    // claims 2 and 3 are cut by the budget. Nothing refuses: the page is
    // incomplete, not an engine error.
    assert.deepEqual(
      unitsOf(s).map((u) => u.complete),
      [true, false, false],
    );
  });

  it("T5.10 fairness pin: claims on different papers are judged independently", async () => {
    alphaPaper("10.1111/t5fa", "Fair A", true);
    alphaPaper("10.1111/t5fb", "Fair B", true);
    const ka = keysOf("10.1111/t5fa");
    const kb = keysOf("10.1111/t5fb");
    writeConfig();
    const { hooks, calls } = engine(byAlpha);
    const frag = `\\section{S}\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} first ${cite(ka)}.\n${ALPHA[0].toUpperCase()}${ALPHA.slice(1)} second ${cite(kb)}.\n`;
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const s = S(r);
    assert.deepEqual(
      unitsOf(s).map((u) => u.status),
      ["supported", "supported"],
    );
    assert.ok(calls.length >= 2, "round 1 runs per-paper bundles");
    for (const u of unitsOf(s)) assert.equal(u.complete, true);
  });

  it("T5.11 cancellation pin: an aborted page stops between units", async () => {
    alphaPaper("10.1111/t5ca", "Cancel Paper", true);
    writeConfig();
    const { hooks } = engine(byAlpha);
    const controller = new AbortController();
    controller.abort();
    const { CancelledError } = await import("../src/core/verify/claim.ts");
    await assert.rejects(verifyClaimTool(ctx({ signal: controller.signal }), { text: `\\section{S}\n${ALPHA} ${cite(keysOf("10.1111/t5ca"))}.\n` } as VerifyArgs, hooks), CancelledError);
  });
});

describe("V5a sources stored by an older heading detector", () => {
  it("T5.12 the primed page re-derives stale PDF marks first, so an appendix fact after References is judged and supported", async () => {
    // A PDF source stored under an older section policy: its marks miss the appendix heading after References,
    // so the appendix text sits inside the References section until the current detector re-derives the marks.
    const doi = "10.1111/t512";
    const intro = `1. Introduction\n\n${filler("in", 900)}`;
    const refs = "References\n\n[1] A. Author, A title, Venue, 2024.\n[2] B. Author, Another title, Venue, 2025.";
    const app = `A Parallel Decoding Scheme\n\n${filler("ap", 300)}\n\nThe parallel scheme decodes four tokens per step on every benchmark.\n\n${filler("ap-b", 300)}`;
    const text = [intro, refs, app].join("\n\n");
    const stale: SectionMark[] = ["1. Introduction", "References"].map((h) => ({ start: text.indexOf(h), heading: h, level: 1 }));
    registerPaper(db, { doi, title: "Decoding", authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", "512,"), bibtexSource: "crossref" }, { now: NOW });
    const oldPolicy = { chunk_tokens: 300, overlap_tokens: 0, chars_per_token: 2.8, boundary: "section" as const };
    publishSource(db, doi, { kind: "local-file", ref: "512.pdf", license: null, digest: "5".repeat(64), extraction: "unpdf@1.0.0", text, pageStarts: [0], sections: stale }, oldPolicy, NOW());
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "chunking.yaml"),
      "chunking:\n  chunk_tokens: 256\n  overlap_tokens: 0\n  chars_per_token: 2.8\n  boundary: section\nverification:\n  engine: llama-cpp\n  min_confidence: 0.99\n  workers: 2\n  max_judgments: 120\n",
    );
    const { hooks } = engine((r) => (r.state.includes("decodes four tokens per step") && r.instructions.includes("decodes four tokens per step") ? 0.999 : 0.02));
    const frag = `\\section{S}\nThe parallel scheme decodes four tokens per step ${cite(keysOf(doi))}.\n`;
    const r = await verifyClaimTool(ctx(), { text: frag } as VerifyArgs, hooks);
    assert.equal(refused(r), undefined);
    const [u] = unitsOf(S(r));
    assert.equal(u.status, "supported", `status ${u.status}, failedCites ${JSON.stringify(u.failedCites)}`);
    assert.equal(u.failedCites, undefined);
  });
});
