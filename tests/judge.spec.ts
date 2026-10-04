/**
 * Judgment execution (KTD8–KTD10, R13, R15): cache-first, lazily constructed
 * engine, validated scores, bounded concurrency and work, honest interruption.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry } from "../src/core/registry.ts";
import { EngineError, type ClaimEngine } from "../src/core/verify/claim.ts";
import { judgePassages, isSupported, type JudgeOptions } from "../src/core/verify/judge.ts";
import { cachedJudgments, passageHashOf, saveJudgments } from "../src/core/verify/store.ts";

const ID = { model: "fake:m1", protocol: "systemone-noul-v1" };
const CLAIM = "Cells age faster at high temperature.";
const NOW = new Date("2026-10-04T00:00:00Z");

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-judge-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const passages = (n: number) => Array.from({ length: n }, (_, i) => ({ text: `passage number ${i} about batteries` , hash: passageHashOf(`passage number ${i} about batteries`) }));
/** Engine whose answer for a row is derived from the row's own text, so misalignment is detectable. */
const scoring = (log: string[][] = []): ClaimEngine => ({
  run: async (rows) => {
    log.push(rows.map((r) => r.state));
    return rows.map((r) => 0.5 + Number(/number (\d+)/.exec(r.state)![1]) / 100);
  },
});
const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({
  db, queue: new WriteQueue(), now: () => NOW, identity: ID, createEngine: () => scoring(), workers: 2, batchSize: 3, maxFresh: 100, ...over,
});

describe("judgePassages", () => {
  it("fully cached judgments need no engine and no credentials", async () => {
    const ps = passages(3);
    saveJudgments(db, CLAIM, ID, ps.map((p, i) => ({ passageHash: p.hash, pTrue: 0.9 + i / 100 })), NOW);
    const r = await judgePassages(opts({ createEngine: () => { throw new EngineError("OPENROUTER_API_KEY is not set"); } }), CLAIM, ps);
    assert.equal(r.interruption, null);
    assert.deepEqual([r.cached, r.fresh, r.unchecked.length], [3, 0, 0]);
    assert.deepEqual(ps.map((p) => r.scores.get(p.hash)), [0.9, 0.91, 0.92]);
  });

  it("mixed hits and misses keep every score aligned to its own passage", async () => {
    const ps = passages(7);
    saveJudgments(db, CLAIM, ID, [1, 4].map((i) => ({ passageHash: ps[i].hash, pTrue: 0.123 })), NOW);
    const log: string[][] = [];
    const r = await judgePassages(opts({ createEngine: () => scoring(log) }), CLAIM, ps);
    ps.forEach((p, i) => assert.equal(r.scores.get(p.hash), i === 1 || i === 4 ? 0.123 : 0.5 + i / 100, `passage ${i}`));
    assert.deepEqual([r.cached, r.fresh], [2, 5]);
    assert.equal(log.flat().length, 5, "only misses reach the engine");
    assert.ok(log.every((b) => b.length <= 3), "batch size bound");
  });

  it("an empty set and an all-cached set never call or build the engine", async () => {
    let built = 0;
    const o = opts({ createEngine: () => { built++; return scoring(); } });
    await judgePassages(o, CLAIM, []);
    const ps = passages(2);
    saveJudgments(db, CLAIM, ID, ps.map((p) => ({ passageHash: p.hash, pTrue: 0.7 })), NOW);
    await judgePassages(o, CLAIM, ps);
    assert.equal(built, 0);
  });

  it("duplicate passages are judged once", async () => {
    const [p] = passages(1);
    const log: string[][] = [];
    const r = await judgePassages(opts({ createEngine: () => scoring(log) }), CLAIM, [p, p, p]);
    assert.equal(log.flat().length, 1);
    assert.equal(r.scores.size, 1);
  });

  it("fresh judgments persist and the next run is fully cached", async () => {
    const ps = passages(4);
    await judgePassages(opts(), CLAIM, ps);
    assert.equal(cachedJudgments(db, CLAIM, ID, ps.map((p) => p.hash)).size, 4);
    const again = await judgePassages(opts({ createEngine: () => { throw new Error("must not build"); } }), CLAIM, ps);
    assert.deepEqual([again.cached, again.fresh], [4, 0]);
  });

  for (const [label, scores] of [
    ["too few scores", [0.9]],
    ["too many scores", [0.9, 0.9, 0.9, 0.9]],
    ["a NaN score", [0.9, Number.NaN, 0.9]],
    ["an infinite score", [0.9, Number.POSITIVE_INFINITY, 0.9]],
    ["a score above 1", [0.9, 1.5, 0.9]],
    ["a negative score", [0.9, -0.1, 0.9]],
    ["a non-number", [0.9, "0.9" as unknown as number, 0.9]],
  ] as const) {
    it(`${label} fails explicitly and nothing is persisted`, async () => {
      const ps = passages(3);
      const r = await judgePassages(opts({ createEngine: () => ({ run: async () => [...scores] }) }), CLAIM, ps);
      assert.equal(r.interruption?.reason, "engine_failure");
      assert.match(r.interruption!.detail, /invalid/i);
      assert.equal(r.scores.size, 0);
      assert.equal(cachedJudgments(db, CLAIM, ID, ps.map((p) => p.hash)).size, 0, "not cached as a refutation or anything else");
    });
  }

  it("reuse is keyed by decision identity: another model or protocol misses the cache", async () => {
    const ps = passages(2);
    saveJudgments(db, CLAIM, ID, ps.map((p) => ({ passageHash: p.hash, pTrue: 0.99 })), NOW);
    for (const other of [{ ...ID, model: "fake:m2" }, { ...ID, protocol: "systemone-noul-v2" }]) {
      const r = await judgePassages(opts({ identity: other }), CLAIM, ps);
      assert.deepEqual([r.cached, r.fresh], [0, 2]);
    }
    assert.equal((await judgePassages(opts(), "A different claim.", ps)).cached, 0);
  });

  it("without an effective identity nothing is read from or written to the cache", async () => {
    const ps = passages(2);
    saveJudgments(db, CLAIM, ID, ps.map((p) => ({ passageHash: p.hash, pTrue: 0.99 })), NOW);
    const r = await judgePassages(opts({ identity: null }), CLAIM, ps);
    assert.deepEqual([r.cached, r.fresh], [0, 2]);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM claim_judgments").get() as { n: number }).n, 2, "no new rows");
  });

  it("stops at the work budget: judged scores are kept, the rest is reported unchecked", async () => {
    const ps = passages(10);
    saveJudgments(db, CLAIM, ID, [{ passageHash: ps[0].hash, pTrue: 0.8 }], NOW);
    const r = await judgePassages(opts({ maxFresh: 4 }), CLAIM, ps);
    assert.equal(r.interruption?.reason, "budget");
    assert.equal(r.fresh, 4);
    assert.equal(r.cached, 1, "cache hits are free and never count against the budget");
    assert.equal(r.unchecked.length, 5);
    assert.deepEqual(r.unchecked, ps.slice(5).map((p) => p.hash), "deterministic order: earliest candidates are judged first");
  });

  it("honours cancellation between batches", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const ps = passages(9);
    const r = await judgePassages(opts({ workers: 1, signal: ctl.signal, createEngine: () => ({ run: async (rows) => { calls++; ctl.abort(); return rows.map(() => 0.6); } }) }), CLAIM, ps);
    assert.equal(r.interruption?.reason, "cancelled");
    assert.equal(calls, 1);
    assert.equal(r.fresh, 3);
    assert.equal(r.unchecked.length, 6);
  });

  it("an engine failure mid-run keeps earlier batches and reports the remainder", async () => {
    const ps = passages(9);
    let n = 0;
    const r = await judgePassages(opts({ workers: 1, createEngine: () => ({ run: async (rows) => { if (++n === 2) throw new EngineError("HTTP 429 daily limit"); return rows.map(() => 0.7); } }) }), CLAIM, ps);
    assert.equal(r.interruption?.reason, "engine_failure");
    assert.match(r.interruption!.detail, /429/);
    assert.equal(r.fresh, 3);
    assert.equal(r.unchecked.length, 6);
    assert.equal(cachedJudgments(db, CLAIM, ID, ps.map((p) => p.hash)).size, 3, "completed work stays cached");
  });

  it("R5/R10: an engine error that echoes submitted passage text is withheld, not passed to the agent", async () => {
    const ps = passages(3);
    const echo = `HTTP 400: invalid input near "${ps[1].text.slice(0, 40)}" while decoding`;
    const r = await judgePassages(opts({ createEngine: () => ({ run: async () => { throw new EngineError(echo); } }) }), CLAIM, ps);
    assert.equal(r.interruption?.reason, "engine_failure");
    assert.ok(!r.interruption!.detail.includes(ps[1].text.slice(0, 24)), r.interruption!.detail);
    assert.match(r.interruption!.detail, /withheld/i);
    const plain = await judgePassages(opts({ createEngine: () => ({ run: async () => { throw new EngineError("HTTP 429 daily limit"); } }) }), CLAIM, passages(2));
    assert.match(plain.interruption!.detail, /429 daily limit/, "ordinary errors stay actionable");
  });

  it("an engine that cannot be built is an engine failure, not a crash, and nothing was judged", async () => {
    const r = await judgePassages(opts({ createEngine: () => { throw new EngineError("openrouter decisions engine: OPENROUTER_API_KEY is not set"); } }), CLAIM, passages(2));
    assert.equal(r.interruption?.reason, "engine_failure");
    assert.match(r.interruption!.detail, /OPENROUTER_API_KEY/);
    assert.deepEqual([r.fresh, r.unchecked.length], [0, 2]);
  });

  it("never runs more concurrent engine calls than the configured workers, and still aligns scores", async () => {
    let active = 0;
    let peak = 0;
    const ps = passages(24);
    const engine: ClaimEngine = {
      run: async (rows) => {
        peak = Math.max(peak, ++active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return rows.map((r) => 0.5 + Number(/number (\d+)/.exec(r.state)![1]) / 100);
      },
    };
    const r = await judgePassages(opts({ workers: 3, createEngine: () => engine }), CLAIM, ps);
    assert.ok(peak <= 3 && peak > 1, `peak ${peak}`);
    ps.forEach((p, i) => assert.equal(r.scores.get(p.hash), 0.5 + i / 100));
  });

  it("only the engine score decides support: a low score is never reported as contradiction", async () => {
    assert.equal(isSupported(0.995, 0.99), true);
    assert.equal(isSupported(0.2, 0.99), false);
    assert.equal(isSupported(0.0001, 0.99), false, "an engine's confident 'no' is not a supported claim and not evidence of refutation");
    const r = await judgePassages(opts({ createEngine: () => ({ run: async (rows) => rows.map(() => 0.0001) }) }), CLAIM, passages(2));
    assert.deepEqual(Object.keys(r).sort(), ["cached", "fresh", "interruption", "scores", "unchecked"]);
  });
});
