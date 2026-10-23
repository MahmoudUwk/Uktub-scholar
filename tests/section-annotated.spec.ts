/**
 * W5: write_section assembly over the annotated checker.
 * Invented text throughout; no paper text, no network (fakes only).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  buildAnnotatedRepairPrompt,
  buildRepairPrompt,
  buildWriterPrompt,
  runWriteSection,
  type SectionDeps,
  type UnitVerdict,
  type VerifyPage,
} from "../src/agent/section-writer.ts";
import { parseAnnotatedOutput, type AnnotatedClaim, type ParsedAnnotations } from "../src/core/verify/annotations.ts";
import { createSourceTrace, type SourceTrace } from "../src/agent/source-trace.ts";
import { composeSectionResultText } from "../src/agent/section-tool.ts";
import type { SectionResult } from "../src/agent/section-writer.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PIN = JSON.parse(readFileSync(`${ROOT}tests/fixtures/section-prompts-pin.json`, "utf8")) as {
  writerParams: { goal: string; papers: string[] };
  defaultWriter: string;
  defaultRepair: string;
  annotatedWriter: string;
  annotatedRepair: string;
  repairFailures: UnitVerdict[];
  annotatedRepairFailures: UnitVerdict[];
  repairNotes: Array<{ marker: number; citekey: string; ref: string; hint: string }>;
};

describe("W5.1 writer and repair prompts", () => {
  it("default writer and repair prompts are frozen (pin)", () => {
    assert.equal(buildWriterPrompt(PIN.writerParams), PIN.defaultWriter);
    assert.equal(buildRepairPrompt(PIN.repairFailures), PIN.defaultRepair);
  });

  it("annotated writer prompt carries the three contract lines and drops the default last line", () => {
    const p = buildWriterPrompt(PIN.writerParams, { annotated: true });
    assert.match(p, /Put each factual sentence on its own line and end that line with a LaTeX comment/);
    assert.match(p, /After the LaTeX add a line `---SOURCES---`/);
    assert.match(p, /Return the LaTeX and the sources together in ONE code block, nothing else\./);
    assert.doesNotMatch(p, /Return only the LaTeX section body/);
  });

  it("annotated writer and repair prompts are frozen (pin)", () => {
    assert.equal(buildWriterPrompt(PIN.writerParams, { annotated: true }), PIN.annotatedWriter);
    assert.equal(buildAnnotatedRepairPrompt(PIN.annotatedRepairFailures, PIN.repairNotes), PIN.annotatedRepair);
  });
});

describe("W5.2 legacy path without the annotated seam (green guard)", () => {
  it("marker text reaches verifyDocument untouched and the prompt is the default", async () => {
    const seen: Array<{ text: string; offset: number }> = [];
    const writers: string[] = [];
    const raw = "```latex\nInvented claim one. \\cite{smith2024} % c1\n---SOURCES---\nc1 | smith2024 | section=Methods\n```";
    const deps: SectionDeps = {
      runWriter: async (prompt: string) => {
        writers.push(prompt);
        return raw;
      },
      verifyDocument: async (text: string, offset: number) => {
        seen.push({ text, offset });
        const units: UnitVerdict[] = [{ id: "u1", excerpt: "Invented claim one.", status: "supported", suggested: [], pointers: [] }];
        return { units, summary: { total: 1, from: 0, units: 1 }, next: null };
      },
      abortWriter: async () => {},
      disposeWriter: () => {},
    };
    const out = await runWriteSection(deps, { goal: "g", papers: ["smith2024"] });
    assert.equal(seen.length, 1);
    assert.ok(seen[0]!.text.includes("% c1"), "marker comment is untouched without the seam");
    assert.ok(seen[0]!.text.includes("---SOURCES---"), "source lines are untouched without the seam");
    assert.ok(!writers[0]!.includes("---SOURCES---"), "the prompt is the default brief");
    assert.equal(out.annotated, undefined);
    assert.equal(out.latex, seen[0]!.text);
  });
});

// ── w5b: the annotated flow (W5.3–W5.8, W5.10) ─────────────────────────────

const DRAFT_OK = [
  "```latex",
  "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
  "Invented lamp light shifts the curve upward \\cite{jones2023} on its own. % c2",
  "---SOURCES---",
  "c1 | smith2024 | section=Growth conditions",
  "c2 | jones2023 | section=Lamp effects",
  "```",
].join("\n");

interface SeamCall {
  offset: number;
  claims: Array<{ marker: number; cites: string[] }>;
}

function annotatedHarness(opts: {
  drafts: string[];
  verdict?: (marker: number, claim: AnnotatedClaim) => Partial<UnitVerdict>;
  pageSize?: number;
  trace?: SourceTrace;
}): { writers: string[]; documentCalls: () => number; seamCalls: SeamCall[]; deps: SectionDeps } {
  const writers: string[] = [];
  const seamCalls: SeamCall[] = [];
  let documentCalls = 0;
  let di = 0;
  const pageSize = opts.pageSize ?? Number.MAX_SAFE_INTEGER;
  const deps: SectionDeps = {
    runWriter: async (prompt: string) => {
      writers.push(prompt);
      return opts.drafts[Math.min(di++, opts.drafts.length - 1)]!;
    },
    verifyDocument: async (text: string, _offset: number) => {
      documentCalls += 1;
      const parsed = parseAnnotatedOutput(text);
      const units: UnitVerdict[] = parsed.units.map((u) => ({ id: u.id, excerpt: u.plain, status: "supported" as const, suggested: [], pointers: [] }));
      return { units, summary: { total: units.length, from: 0, units: units.length }, next: null };
    },
    verifyAnnotated: async (parsed: ParsedAnnotations, offset: number): Promise<VerifyPage> => {
      seamCalls.push({ offset, claims: parsed.claims.map((c) => ({ marker: c.marker, cites: [...c.cites] })) });
      // The verdict shapes the draft check only (di === 1: one draft served);
      // the repair check comes back clean unless the test says otherwise.
      const inDraft = di === 1;
      const all: UnitVerdict[] = parsed.units.map((u) => {
        const claim = parsed.claims.find((c) => c.unitId === u.id);
        const v = claim !== undefined && inDraft && opts.verdict !== undefined ? (opts.verdict(claim.marker, claim) ?? {}) : {};
        return { id: u.id, excerpt: u.plain, status: "supported" as const, suggested: [], pointers: [], ...v };
      });
      const slice = all.slice(offset, offset + pageSize);
      const next = offset + pageSize < all.length ? offset + pageSize : null;
      return { units: slice, summary: { total: all.length, from: offset, units: slice.length }, next };
    },
    abortWriter: async () => {},
    disposeWriter: () => {},
    ...(opts.trace !== undefined ? { trace: opts.trace } : {}),
  };
  return { writers, documentCalls: () => documentCalls, seamCalls, deps };
}

describe("W5.3 annotated draft in one fence", () => {
  it("verifyAnnotated gets bound claims, verifyDocument never runs, markers are stripped", async () => {
    const h = annotatedHarness({ drafts: [DRAFT_OK] });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.ok(h.writers[0]!.includes("---SOURCES---"), "the child prompt carries the annotated contract");
    assert.equal(h.seamCalls.length, 1);
    assert.deepEqual(h.seamCalls[0]!.claims, [
      { marker: 1, cites: ["smith2024"] },
      { marker: 2, cites: ["jones2023"] },
    ]);
    assert.equal(h.documentCalls(), 0, "verifyDocument never runs in annotated mode");
    assert.doesNotMatch(out.latex, /% ?c\d/);
    assert.doesNotMatch(out.latex, /---SOURCES---/);
    assert.equal(out.annotated?.mode, "annotated");
    assert.equal(out.repaired, false);
    assert.equal(out.unresolved.length, 0);
  });
});

describe("W5.4 SOURCES in a second fence", () => {
  it("source-missing is reported for every cited key", async () => {
    const raw = ["```latex", "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1", "Invented lamp light shifts the curve \\cite{jones2023} on its own. % c2", "```", "```sources", "c1 | smith2024 | section=Growth conditions", "```"].join("\n");
    const h = annotatedHarness({ drafts: [raw] });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(h.writers.length, 1, "an annotation problem alone never triggers a repair");
    const missing = (out.annotated?.problems ?? []).filter((p) => p.code === "source-missing").map((p) => [p.marker, p.citekey]);
    assert.deepEqual(missing, [
      [1, "smith2024"],
      [2, "jones2023"],
    ]);
  });
});

const DRAFT_C2_FAIL = [
  "```latex",
  "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
  "Invented lamp light shifts the curve upward \\cite{jones2023} on its own. % c2",
  "---SOURCES---",
  "c1 | smith2024 | section=Growth conditions",
  "c2 | jones2023 | section=Appendix",
  "```",
].join("\n");

describe("W5.5 repair by cN", () => {
  it("the brief names [c2] with failed cites and c2's unread hint; the repair is re-parsed and rechecked once", async () => {
    const h = annotatedHarness({
      drafts: [DRAFT_C2_FAIL, DRAFT_OK],
      verdict: (m) => (m === 2 ? { status: "cited-unsupported", failedCites: ["jones2023"] } : { status: "supported" }),
      trace: createSourceTrace(),
    });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(h.writers.length, 2, "exactly one repair round");
    const brief = h.writers[1]!;
    assert.ok(brief.includes("[c2]"), "the repair brief names the claim");
    assert.ok(brief.includes("jones2023"), "the brief names the failed cite");
    assert.ok(brief.includes("c2 jones2023 section=Appendix was never opened"), "c2's unread hint reaches the brief");
    assert.doesNotMatch(brief, /\[u\d/, "renamed claims never leak unit ids");
    assert.equal(h.seamCalls.length, 2, "the repair output is re-parsed and rechecked once");
    assert.equal(out.unresolved.length, 0);
  });
});

describe("W5.6 annotation problems never repair alone", () => {
  it("all supported plus a source-missing problem means no repair, problem reported", async () => {
    const raw = [
      "```latex",
      "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
      "Invented lamp light shifts the curve \\cite{jones2023} on its own. % c2",
      "---SOURCES---",
      "c1 | smith2024 | section=Growth conditions",
      "```",
    ].join("\n");
    const h = annotatedHarness({ drafts: [raw] });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(h.writers.length, 1, "no repair round");
    assert.equal(out.repaired, false);
    const missing = (out.annotated?.problems ?? []).filter((p) => p.code === "source-missing");
    assert.equal(missing.length, 1);
    assert.deepEqual([missing[0]!.marker, missing[0]!.citekey], [2, "jones2023"]);
  });
});

describe("W5.7 counts cover unmarked units", () => {
  it("counts include unmarked units; firstDraft reports markers and citedUnits", async () => {
    const raw = [
      "```latex",
      "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
      "Invented lamp light shifts the curve \\cite{jones2023} on its own. % c2",
      "An unmarked invented sentence still cites \\cite{smith2024} prior work.",
      "---SOURCES---",
      "c1 | smith2024 | section=Growth conditions",
      "c2 | jones2023 | section=Lamp effects",
      "```",
    ].join("\n");
    const h = annotatedHarness({ drafts: [raw] });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(out.final.units, 3, "the unmarked unit is checked too");
    assert.equal(out.final.ok, 3);
    assert.equal(out.annotated?.firstDraft.markers, 2);
    assert.equal(out.annotated?.firstDraft.citedUnits, 3);
  });
});

describe("W5.8 annotated-check call cap", () => {
  const DRAFT_3_FAIL = [
    "```latex",
    "Invented steady cultures divide \\cite{smith2024} at a constant rate. % c1",
    "Invented lamp light shifts the curve upward \\cite{jones2023} on its own. % c2",
    "An invented third sentence cites \\cite{smith2024} other work. % c3",
    "---SOURCES---",
    "c1 | smith2024 | section=Growth conditions",
    "c2 | jones2023 | section=Lamp effects",
    "c3 | smith2024 | section=Appendix",
    "```",
  ].join("\n");

  it("a normal run uses exactly 2 calls; three pages per check are rejected at the fifth call naming the cap", async () => {
    const normal = annotatedHarness({
      drafts: [DRAFT_C2_FAIL, DRAFT_OK],
      verdict: (m) => (m === 2 ? { status: "cited-unsupported", failedCites: ["jones2023"] } : { status: "supported" }),
    });
    const okOut = await runWriteSection(normal.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(normal.seamCalls.length, 2, "draft plus one repair check");
    assert.equal(okOut.unresolved.length, 0);

    const capped = annotatedHarness({
      drafts: [DRAFT_3_FAIL, DRAFT_OK],
      pageSize: 1,
      verdict: (m) => (m === 3 ? { status: "cited-unsupported", failedCites: ["smith2024"] } : { status: "supported" }),
    });
    await assert.rejects(() => runWriteSection(capped.deps, { goal: "g", papers: ["smith2024", "jones2023"] }), /at most 4 verifyAnnotated calls/);
  });
});

describe("W5.10 unread sources are report-only unless the claim failed", () => {
  const seenTrace = (): SourceTrace => {
    const trace = createSourceTrace();
    trace.record("passages", {
      structuredContent: {
        hits: [
          {
            citekey: "smith2024",
            section: "Growth conditions",
            excerpt: "invented excerpt",
            pointer: "10.1000/smith2024@aa11bb22#10-20",
            doi: "10.1000/smith2024",
            withheld: null,
          },
        ],
      },
    });
    return trace;
  };

  it("the unread source of a supported claim is reported without a repair", async () => {
    const h = annotatedHarness({ drafts: [DRAFT_C2_FAIL], trace: seenTrace() });
    const out = await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(h.writers.length, 1, "no repair");
    assert.deepEqual(
      (out.annotated?.unread ?? []).map((u) => [u.marker, u.citekey]),
      [[2, "jones2023"]],
      "only the unopened source is reported",
    );
  });

  it("the unread hint of a failed claim reaches the repair brief", async () => {
    const h = annotatedHarness({
      drafts: [DRAFT_C2_FAIL, DRAFT_OK],
      verdict: (m) => (m === 2 ? { status: "cited-unsupported", failedCites: ["jones2023"] } : { status: "supported" }),
      trace: seenTrace(),
    });
    await runWriteSection(h.deps, { goal: "g", papers: ["smith2024", "jones2023"] });
    assert.equal(h.writers.length, 2, "exactly one repair round");
    const brief = h.writers[1]!;
    assert.ok(brief.includes("c2 jones2023 section=Appendix was never opened"), "c2's hint reaches the brief");
    assert.doesNotMatch(brief, /c1 smith2024/, "the opened source stays out of the brief");
  });
});

describe("W5.9 claim table", () => {
  const HINT = "c2 jones2023 section=Appendix was never opened: run passages with a query from the heading words (\"Appendix\"), or replace the source or drop the claim.";
  const annotatedOut: SectionResult = {
    latex: "Invented line one.\nInvented line two.",
    summary: "1/2 supported (incomplete: 0), no repair needed.",
    unresolved: [{ id: "c2", excerpt: "Invented line two.", status: "cited-unsupported", suggested: [], pointers: [] }],
    firstDraft: { units: 2, ok: 1, incomplete: 0 },
    final: { units: 2, ok: 1, incomplete: 0 },
    repaired: false,
    words: 6,
    annotated: {
      mode: "annotated",
      firstDraft: { mode: "annotated", markers: 2, citedUnits: 2 },
      claims: [
        { marker: 1, status: "supported", sources: ["smith2024"], at: ["stated"], unread: [] },
        { marker: 2, status: "cited-unsupported", sources: ["jones2023"], at: ["unsupported"], unread: ["jones2023"] },
      ],
      problems: [{ code: "source-missing", marker: 2, citekey: "jones2023", line: 1, detail: "reported" }],
      unread: [{ marker: 2, citekey: "jones2023", ref: "section=Appendix", hint: HINT }],
      checkCalls: 1,
      work: { cells: 2, fresh: 2, cached: 0, calls: 1 },
    },
  };

  it("renders the claim table after the counts line", () => {
    const text = composeSectionResultText(annotatedOut);
    assert.ok(text.includes("Claims:\nc1 supported: smith2024 stated\nc2 cited-unsupported: not supported by jones2023\n"), "per-claim line with per-paper outcome");
    assert.ok(text.includes(`Source notes: ${HINT}\n`), "unread hints ride the table");
    assert.ok(text.includes("Annotation problems: source-missing c2 jones2023"), "problems ride the table");
  });

  it("a result without annotated is byte-identical to the un-tabled text", () => {
    const { annotated: _dropped, ...plain } = annotatedOut;
    void _dropped;
    assert.equal(
      composeSectionResultText(plain),
      "Invented line one.\nInvented line two.\n\n---\n1/2 supported (incomplete: 0), no repair needed.\nfirst draft 1/2 supported; final 1/2; 6 words\nUnresolved:\n- [c2] cited-unsupported: \"Invented line two.\"",
    );
  });
});
