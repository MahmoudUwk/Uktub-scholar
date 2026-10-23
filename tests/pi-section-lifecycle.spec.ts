/**
 * Section-writer lifecycle hardening, review round: single-owner abort
 * (abortWriter/disposeWriter callbacks), duplicate-page refusal, and
 * explicit incomplete-unresolved output. Deterministic actual behavior.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  runWriteSection,
  type SectionDeps,
  type UnitVerdict,
  type VerifyPage,
} from "../src/pi/write-section.ts";

const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const unit = (id: string, status: UnitVerdict["status"], extra: Partial<UnitVerdict> = {}): UnitVerdict => ({
  id, excerpt: `claim ${id}`, status, suggested: [], pointers: [], ...extra,
});

const page = (units: UnitVerdict[], from: number, total: number, next: number | null): VerifyPage => ({
  units, summary: { total, from, units: units.length }, next,
});

/** Fully owned stub: counts every callback the lifecycle may invoke. */
function owned(impl: Partial<{
  runWriter: (prompt: string) => Promise<string>;
  verifyDocument: (text: string, offset: number) => Promise<VerifyPage>;
  abortWriter: () => Promise<void>;
  disposeWriter: () => void;
}> = {}): SectionDeps & { writers: number; verifies: number; aborts: number; disposes: number } {
  const d = {
    writers: 0,
    verifies: 0,
    aborts: 0,
    disposes: 0,
    runWriter: async (_p: string) => { d.writers += 1; return "v1"; },
    verifyDocument: async (_t: string, _o: number) => { d.verifies += 1; return page([unit("u1", "supported")], 0, 1, null); },
    abortWriter: async () => { d.aborts += 1; },
    disposeWriter: () => { d.disposes += 1; },
    ...impl,
  } as SectionDeps & { writers: number; verifies: number; aborts: number; disposes: number };
  return d;
}

/** Paged stub: serves the given full unit lists per text generation. */
function paged(texts: string[], lists: Record<string, UnitVerdict[]>): SectionDeps & { writers: string[]; verifies: number; aborts: number; disposes: number; calls: { text: string; offset: number }[] } {
  let gen = 0;
  const calls: { text: string; offset: number }[] = [];
  const d = {
    writers: [] as string[],
    calls,
    verifies: 0,
    aborts: 0,
    disposes: 0,
    runWriter: async (prompt: string) => { d.writers.push(prompt); return texts[Math.min(gen++, texts.length - 1)]!; },
    verifyDocument: async (text: string, offset: number) => {
      d.verifies += 1; calls.push({ text, offset });
      const full = lists[text] ?? [];
      const slice = full.slice(offset, offset + 50);
      const next = offset + slice.length < full.length ? offset + slice.length : null;
      return page(slice, offset, full.length, next);
    },
    abortWriter: async () => { d.aborts += 1; },
    disposeWriter: () => { d.disposes += 1; },
  } as unknown as SectionDeps & { writers: string[]; verifies: number; aborts: number; disposes: number; calls: { text: string; offset: number }[] };
  return d;
}

describe("lifecycle: full paging", () => {
  it("verifies every page in order; a last-page failure triggers one repair re-verified from offset 0", async () => {
    const first: UnitVerdict[] = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    first[54] = unit("u55", "unsourced");
    const repaired: UnitVerdict[] = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    const d = paged(["v1", "v2"], { v1: first, v2: repaired });
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(out.unresolved.length, 0);
    assert.deepEqual(d.calls.map((c) => c.offset), [0, 50, 0, 50], "initial pages then repair pages from 0");
    assert.equal(d.calls[0]!.text, "v1");
    assert.equal(d.calls[2]!.text, "v2", "repaired EXACT text is what gets paged");
    assert.equal(d.writers.length, 2, "exactly one repair round");
    assert.equal(d.disposes, 1, "child disposed exactly once on success");
    assert.equal(d.aborts, 0, "no abort on the clean path");
  });

  it("a last-page failure surviving repair stays unresolved after the all-page recheck", async () => {
    const bad: UnitVerdict[] = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    bad[54] = unit("u55", "cited-unsupported");
    const d = paged(["v1", "v2"], { v1: bad, v2: bad });
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.deepEqual(d.calls.map((c) => c.offset), [0, 50, 0, 50]);
    assert.equal(d.writers.length, 2, "exactly one repair round");
    assert.equal(out.unresolved.length, 1);
    assert.equal(out.unresolved[0]!.id, "u55");
  });

  it("handles exact 50-unit single-page, 51-unit two-page, and 100-unit two-full-page boundaries cleanly", async () => {
    for (const [count, expectedOffsets] of [
      [50, [0]],
      [51, [0, 50]],
      [100, [0, 50]],
    ] as const) {
      const units = Array.from({ length: count }, (_, i) => unit(`u${i + 1}`, "supported"));
      const d = paged(["v1"], { v1: units });
      const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
      assert.equal(out.unresolved.length, 0, `expected 0 unresolved for count=${count}`);
      assert.deepEqual(d.calls.map((c) => c.offset), expectedOffsets, `unexpected offsets for count=${count}`);
      assert.equal(d.writers.length, 1);
      assert.equal(d.disposes, 1);
    }
  });
});

describe("lifecycle: pagination refusal", () => {
  it("rejects duplicate unit IDs across pages even when offsets and totals look plausible", async () => {
    const d = owned({
      runWriter: async () => "v1",
      verifyDocument: (() => {
        let n = 0;
        return async () => {
          n += 1;
          if (n === 1) return page(Array.from({ length: 50 }, (_, i) => unit(`u${i + 1}`, "supported")), 0, 55, 50);
          // Second page repeats u50 instead of continuing: plausible offsets, duplicated unit.
          const dup = [unit("u50", "supported"), ...Array.from({ length: 4 }, (_, i) => unit(`u${51 + i}`, "supported"))];
          return page(dup, 50, 55, null);
        };
      })(),
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /duplicat/i);
    assert.equal(d.disposes, 1);
  });

  it("rejects malformed unit identity and status conservatively", async () => {
    for (const bad of [
      { id: "", excerpt: "x", status: "supported", suggested: [], pointers: [] },
      { id: "u1", excerpt: "x", status: "almost-supported", suggested: [], pointers: [] },
    ]) {
      const d = owned({
        runWriter: async () => "v1",
        verifyDocument: async () => page([bad as unknown as UnitVerdict], 0, 1, null),
      });
      await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /malformed/i);
      assert.equal(d.disposes, 1);
    }
  });

  it("refuses non-progressing next without reporting a partial set as complete", async () => {
    const units = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    let n = 0;
    const d = owned({
      runWriter: async () => "v1",
      verifyDocument: async () => {
        n += 1;
        if (n === 1) return page(units.slice(0, 50), 0, 55, 50);
        return page(units.slice(50), 50, 55, 50 as unknown as null);
      },
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /progress|next|pagination/i);
    assert.equal(d.disposes, 1);
  });

  it("refuses a rewound from-offset on page 2 even when unit IDs are fresh", async () => {
    const units = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    let n = 0;
    const d = owned({
      verifyDocument: async () => {
        n += 1;
        if (n === 1) return page(units.slice(0, 50), 0, 55, 50);
        return page(units.slice(50), 0, 55, null);
      },
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /skipped or duplicated/i);
    assert.equal(d.writers, 1);
    assert.equal(d.disposes, 1);
  });

  it("refuses a next offset that overflows total", async () => {
    const units = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    let n = 0;
    const d = owned({
      verifyDocument: async () => {
        n += 1;
        if (n === 1) return page(units.slice(0, 50), 0, 55, 50);
        return page(units.slice(50), 50, 55, 99);
      },
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /did not progress/i);
    assert.equal(d.writers, 1);
    assert.equal(d.disposes, 1);
  });

  it("refuses a changed total across pages", async () => {
    const units = Array.from({ length: 55 }, (_, i) => unit(`u${i + 1}`, "supported"));
    let n = 0;
    const d = owned({
      runWriter: async () => "v1",
      verifyDocument: async () => {
        n += 1;
        if (n === 1) return page(units.slice(0, 50), 0, 55, 50);
        return page(units.slice(0, 5), 50, 99, null);
      },
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /total/i);
  });

  it("empty verifier output cannot manufacture a clean success", async () => {
    const d = owned({
      runWriter: async () => "v1",
      verifyDocument: async () => page([], 0, 0, null),
    });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /empty|malformed|no units/i);
  });
});

describe("lifecycle: incomplete stays unresolved", () => {
  it("supported-but-incomplete is unresolved, reported, and triggers no rewrite", async () => {
    const u = unit("u1", "supported", { complete: false, pointers: ["doi@r#1-2"] });
    const d = paged(["v1"], { v1: [u] });
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] });
    assert.equal(d.writers.length, 1, "no gratuitous rewrite of a supported unit");
    assert.equal(out.unresolved.length, 1);
    assert.equal(out.unresolved[0]!.id, "u1");
    assert.match(out.summary, /incomplete: 1/);
  });

  it("the tool output names verification incomplete alongside supported", async () => {
    const { unresolvedBlock } = await import("../src/pi/index.ts") as unknown as {
      unresolvedBlock: (units: UnitVerdict[]) => string;
    };
    assert.equal(typeof unresolvedBlock, "function", "output formatter exists");
    assert.equal(unresolvedBlock([]), "Unresolved: none.");
    assert.match(
      unresolvedBlock([unit("u1", "supported", { complete: false })]),
      /u1.*supported.*verification incomplete/i,
      "a supported-but-incomplete unit never reads as a plain supported line",
    );
    assert.match(unresolvedBlock([unit("u2", "unsourced")]), /u2.*unsourced/);
  });
});

describe("lifecycle: single-owner abort", () => {
  it("rejected verification still waits for abort settlement before disposal", async () => {
    const controller = new AbortController();
    let rejectVerify!: (error: Error) => void;
    let finishAbort!: () => void;
    let startedVerify!: () => void;
    const started = new Promise<void>((resolve) => { startedVerify = resolve; });
    const verification = new Promise<VerifyPage>((_resolve, reject) => { rejectVerify = reject; });
    const abort = new Promise<void>((resolve) => { finishAbort = resolve; });
    const d = owned({
      verifyDocument: async () => { startedVerify(); return verification; },
      abortWriter: async () => { d.aborts += 1; return abort; },
    });
    const pending = runWriteSection(d, { goal: "g", papers: ["a"] }, controller.signal);
    pending.catch(() => undefined);
    await started;
    controller.abort();
    rejectVerify(new DOMException("verification cancelled", "AbortError"));
    await sleep(20);
    assert.equal(d.aborts, 1);
    assert.equal(d.disposes, 0, "verification rejection must not bypass pending abort settlement");
    finishAbort();
    await assert.rejects(pending, isAbort);
    assert.equal(d.disposes, 1);
  });

  it("a pre-aborted signal aborts, settles and disposes the owned resource with no writer work", async () => {
    const c = new AbortController();
    c.abort();
    const d = owned();
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal), isAbort);
    assert.equal(d.writers, 0, "never prompted");
    assert.equal(d.verifies, 0);
    assert.equal(d.aborts, 1, "owner aborted the owned resource");
    assert.equal(d.disposes, 1);
  });

  it("a settled writer waits for a pending abort: no next stage and no dispose until abort settlement", async () => {
    const c = new AbortController();
    let writerRes!: (v: string) => void;
    const writerGate = new Promise<string>((res) => { writerRes = res; });
    let abortRes!: () => void;
    const abortGate = new Promise<void>((res) => { abortRes = res; });
    const d = owned({
      runWriter: async () => { d.writers += 1; return writerGate; },
      abortWriter: async () => { d.aborts += 1; return abortGate; },
    });
    const p = runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal);
    await sleep(0);
    c.abort(); // owner must call the real abortWriter callback
    await sleep(0);
    assert.equal(d.aborts, 1, "abort needs the owner callback: nothing else settles the writer");
    writerRes("v1"); // writer settles while the abort is still in flight
    await sleep(20);
    assert.equal(d.verifies, 0, "no verify page before abort settlement");
    assert.equal(d.disposes, 0, "no dispose before abort settlement");
    const state = await Promise.race([p.then(() => "settled" as const, () => "rejected" as const), sleep(20).then(() => "pending" as const)]);
    assert.equal(state, "pending", "the run stays pending while the abort is unsettled");
    abortRes();
    await assert.rejects(() => p, isAbort);
    assert.equal(d.verifies, 0, "no verify page after abort either");
    assert.equal(d.disposes, 1, "disposed exactly once after settlement");
  });

  it("a rejected writer still waits for abort settlement and reports cancellation", async () => {
    const c = new AbortController();
    let writerRej!: (e: unknown) => void;
    const writerGate = new Promise<string>((_res, rej) => { writerRej = rej; });
    let abortRes!: () => void;
    const abortGate = new Promise<void>((res) => { abortRes = res; });
    const d = owned({
      runWriter: async () => { d.writers += 1; return writerGate; },
      abortWriter: async () => { d.aborts += 1; return abortGate; },
    });
    const p = runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal);
    await sleep(0);
    c.abort();
    await sleep(0);
    writerRej(new Error("writer broke"));
    await sleep(20);
    assert.equal(d.disposes, 0, "primary error does not skip abort settlement");
    const state = await Promise.race([p.then(() => "settled" as const, () => "rejected" as const), sleep(20).then(() => "pending" as const)]);
    assert.equal(state, "pending");
    abortRes();
    await assert.rejects(() => p, isAbort, "abort owns the outcome, not the writer error");
    assert.equal(d.disposes, 1);
  });

  it("a failing abort reports the cleanup failure instead of success", async () => {
    const c = new AbortController();
    let writerRes!: (v: string) => void;
    const writerGate = new Promise<string>((res) => { writerRes = res; });
    const d = owned({
      runWriter: async () => writerGate,
      abortWriter: async () => { d.aborts += 1; throw new Error("abort broke"); },
    });
    const p = runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal);
    await sleep(0);
    c.abort();
    await sleep(0);
    assert.equal(d.aborts, 1);
    writerRes("v1");
    await assert.rejects(() => p, /abort broke/, "cleanup failure propagates, never a success");
    assert.equal(d.verifies, 0, "no next stage after a failed abort");
    assert.equal(d.disposes, 1);
  });

  it("abort during a pending verifier runs no repair prompt", async () => {
    const c = new AbortController();
    let verifyRes!: (v: VerifyPage) => void;
    const verifyGate = new Promise<VerifyPage>((res) => { verifyRes = res; });
    let abortRes!: () => void;
    const abortGate = new Promise<void>((res) => { abortRes = res; });
    let pageN = 0;
    const d = owned({
      abortWriter: async () => { d.aborts += 1; return abortGate; },
      verifyDocument: async (_t: string, _o: number) => {
        d.verifies += 1;
        pageN += 1;
        if (pageN === 1) return page(Array.from({ length: 50 }, (_, i) => unit(`u${i + 1}`, "supported")), 0, 55, 50);
        return verifyGate;
      },
    });
    const p = runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal);
    await sleep(0);
    await sleep(0);
    c.abort();
    await sleep(0);
    assert.equal(d.aborts, 1);
    verifyRes(page(Array.from({ length: 5 }, (_, i) => unit(`u${51 + i}`, "supported")), 50, 55, null));
    await sleep(20);
    assert.equal(d.writers, 1, "no repair prompt before abort settlement");
    assert.equal(d.disposes, 0);
    abortRes();
    await assert.rejects(() => p, isAbort);
    assert.equal(d.writers, 1, "no repair prompt after abort either");
    assert.equal(d.disposes, 1);
  });

  it("abort after success never touches the settled child", async () => {
    const c = new AbortController();
    const d = owned();
    const out = await runWriteSection(d, { goal: "g", papers: ["a"] }, c.signal);
    assert.equal(out.unresolved.length, 0);
    c.abort();
    await sleep(10);
    assert.equal(d.aborts, 0, "listener removed: no abort call after success");
    assert.equal(d.writers, 1, "no new prompt after completion");
    assert.equal(d.verifies, 1, "no new page after completion");
    assert.equal(d.disposes, 1, "disposed exactly once");
  });

  it("a verifier error preserves the primary failure with no abort", async () => {
    const d = owned({ verifyDocument: async () => { throw new Error("verify blew up"); } });
    await assert.rejects(() => runWriteSection(d, { goal: "g", papers: ["a"] }), /verify blew up/);
    assert.equal(d.aborts, 0);
    assert.equal(d.disposes, 1);
  });
});
