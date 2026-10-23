/**
 * Phase V3: grid judge over (claim, unit) cells. Additive: `judgePassages` is untouched.
 * Offline: stub engines, real SQLite.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry } from "../src/core/registry.ts";
import type { ClaimEngine } from "../src/core/verify/claim.ts";
import { claimVerdict, judgeGrid, paperVerdict, type JudgeOptions, type JudgeUnit } from "../src/core/verify/judge.ts";
import { cachedJudgments, claimHashOf, passageHashOf, saveJudgments } from "../src/core/verify/store.ts";

const V2 = { model: "fake:m1", protocol: "systemone-noul-criteria-v2" };
const V1 = { model: "fake:m1", protocol: "systemone-noul-criteria-v1" };
const NOW = new Date("2026-10-04T00:00:00Z");

const unit = (text: string): JudgeUnit => ({ text, hash: passageHashOf(text) });
const U1 = unit("unit one about batteries");
const U2 = unit("unit two about batteries");
const U3 = unit("unit three about batteries");
const U4 = unit("unit four about batteries");
const A = "Claim A about cells.";
const B = "Claim B about cells.";
const C = "Claim C about cells.";

let root: string;
let db: DatabaseSync;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "uktub-grid-"));
  db = createRegistry(root);
});
afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
});

const opts = (over: Partial<JudgeOptions> = {}): JudgeOptions => ({
  db, queue: new WriteQueue(), now: () => NOW, identity: V2,
  createEngine: () => { throw new Error("engine must not be built"); },
  workers: 2, batchSize: 3, maxFresh: 100, ...over,
});

/** Engine scoring each row from its own instructions, logging one entry per call. */
const byClaim = (scores: Record<string, number>, log: { state: string; instructions: string[] }[] = []): ClaimEngine => ({
  run: async (rows) => {
    log.push({ state: rows[0]?.state ?? "", instructions: rows.map((r) => r.instructions) });
    return rows.map((r) => scores[r.instructions] ?? 0.5);
  },
});

describe("judgeGrid", () => {
  it("G1 [U1,U2]x[A,B,C] with batchSize 6 -> ONE run call with 6 rows in unit-major order", async () => {
    const rows: { state: string; instructions: string }[] = [];
    let calls = 0;
    const r = await judgeGrid(
      opts({
        batchSize: 6,
        createEngine: () => ({
          run: async (rs) => {
            calls++;
            rows.push(...rs);
            return rs.map((x) => ({ [A]: 0.1, [B]: 0.2, [C]: 0.3 })[x.instructions] ?? 0.5);
          },
        }),
      }),
      [{ units: [U1, U2], claims: [A, B, C] }],
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      rows.map((x) => [x.state, x.instructions]),
      [
        [U1.text, A],
        [U1.text, B],
        [U1.text, C],
        [U2.text, A],
        [U2.text, B],
        [U2.text, C],
      ],
    );
    for (const u of [U1, U2]) {
      assert.equal(r.scores.get(claimHashOf(A))?.get(u.hash), 0.1);
      assert.equal(r.scores.get(claimHashOf(B))?.get(u.hash), 0.2);
      assert.equal(r.scores.get(claimHashOf(C))?.get(u.hash), 0.3);
    }
    assert.deepEqual([r.cached, r.fresh], [0, 6]);
    assert.deepEqual(r.unchecked, []);
    assert.equal(r.interruption, null);
  });

  it("G1b [U1,U2]x[A,B,C] with batchSize 3 -> 2 calls", async () => {
    let calls = 0;
    const inner = byClaim({ [A]: 0.1, [B]: 0.2, [C]: 0.3 });
    const r = await judgeGrid(opts({ createEngine: () => ({ run: async (rows) => { calls++; return inner.run(rows); } }) }), [{ units: [U1, U2], claims: [A, B, C] }]);
    assert.equal(calls, 2);
    assert.deepEqual([r.cached, r.fresh], [0, 6]);
    assert.equal(r.interruption, null);
  });

  it("G2 claims bound to different papers -> only (A,U1),(B,U2)", async () => {
    const log: { state: string; instructions: string[] }[] = [];
    const r = await judgeGrid(
      opts({ createEngine: () => byClaim({ [A]: 0.9, [B]: 0.8 }, log) }),
      [{ units: [U1], claims: [A] }, { units: [U2], claims: [B] }],
    );
    assert.equal(log.length, 2);
    assert.equal(r.scores.get(claimHashOf(A))?.get(U1.hash), 0.9);
    assert.equal(r.scores.get(claimHashOf(B))?.get(U2.hash), 0.8);
    assert.equal(r.scores.get(claimHashOf(A))?.has(U2.hash), false);
    assert.equal(r.scores.get(claimHashOf(B))?.has(U1.hash), false);
  });

  it("G3 a unit shared by two bundles is asked once per claim", async () => {
    const log: { state: string; instructions: string[] }[] = [];
    const r = await judgeGrid(opts({ createEngine: () => byClaim({ [A]: 0.7 }, log) }), [{ units: [U1], claims: [A] }, { units: [U1], claims: [A] }]);
    assert.equal(log.length, 1);
    assert.deepEqual(log[0].instructions, [A]);
    assert.equal(r.scores.get(claimHashOf(A))?.get(U1.hash), 0.7);
    assert.deepEqual([r.cached, r.fresh], [0, 1]);
  });

  it("G4 a second call judges 0 rows: createEngine never called, cached is the earlier fresh", async () => {
    const first = await judgeGrid(opts({ batchSize: 8, createEngine: () => byClaim({ [A]: 0.6 }) }), [{ units: [U1, U2], claims: [A] }]);
    assert.deepEqual([first.cached, first.fresh], [0, 2]);
    let built = 0;
    const second = await judgeGrid(opts({ createEngine: () => { built++; throw new Error("must not build"); } }), [{ units: [U1, U2], claims: [A] }]);
    assert.equal(built, 0);
    assert.deepEqual([second.cached, second.fresh], [2, 0]);
    assert.equal(second.interruption, null);
  });

  it("G4b identity null reads and writes nothing", async () => {
    const r = await judgeGrid(opts({ identity: null, createEngine: () => byClaim({ [A]: 0.6 }) }), [{ units: [U1], claims: [A] }]);
    assert.deepEqual([r.cached, r.fresh], [0, 1]);
    assert.equal(r.scores.get(claimHashOf(A))?.get(U1.hash), 0.6);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM claim_judgments").get() as { n: number }).n, 0);
  });

  it("G5 a v1 identity row is not read under v2 (user_version 6, same table and key)", async () => {
    saveJudgments(db, A, V1, [{ passageHash: U1.hash, pTrue: 0.99 }], NOW);
    let built = 0;
    const r = await judgeGrid(opts({ createEngine: () => { built++; return byClaim({ [A]: 0.5 }); } }), [{ units: [U1], claims: [A] }]);
    assert.equal(built, 1);
    assert.deepEqual([r.cached, r.fresh], [0, 1]);
    assert.equal((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version, 6);
    assert.equal((db.prepare("SELECT COUNT(*) n FROM claim_judgments").get() as { n: number }).n, 2);
  });

  for (const workers of [1, 2]) {
    it(`G6 engine throws for the U2 call only (workers ${workers}) -> U1,U3 scored and cached, U2 unchecked in order`, async () => {
      const r = await judgeGrid(
        opts({
          workers,
          batchSize: 2,
          createEngine: () => ({
            run: async (rows) => {
              if (rows[0].state === U2.text) throw new Error(`server refuses this unit: ${U2.text}`);
              return rows.map(() => 0.8);
            },
          }),
        }),
        [{ units: [U1, U2, U3], claims: [A, B] }],
      );
      assert.equal(r.interruption?.reason, "engine_failure");
      assert.ok(!r.interruption!.detail.includes(U2.text.slice(0, 24)), r.interruption!.detail);
      assert.match(r.interruption!.detail, /withheld/);
      assert.deepEqual([r.cached, r.fresh], [0, 4]);
      for (const u of [U1, U3]) {
        assert.equal(r.scores.get(claimHashOf(A))?.get(u.hash), 0.8);
        assert.equal(r.scores.get(claimHashOf(B))?.get(u.hash), 0.8);
      }
      assert.deepEqual(r.unchecked, [
        { claimHash: claimHashOf(A), hash: U2.hash },
        { claimHash: claimHashOf(B), hash: U2.hash },
      ]);
      assert.equal(cachedJudgments(db, A, V2, [U1.hash, U3.hash]).size, 2);
    });
  }

  it("G7 [0.9,{failed},0.2] -> siblings kept, only the middle unchecked", async () => {
    const r = await judgeGrid(
      opts({ createEngine: () => ({ run: async () => [0.9, { failed: "x" }, 0.2] as unknown as number[] }) }),
      [{ units: [U1], claims: [A, B, C] }],
    );
    assert.equal(r.scores.get(claimHashOf(A))?.get(U1.hash), 0.9);
    assert.equal(r.scores.get(claimHashOf(C))?.get(U1.hash), 0.2);
    assert.deepEqual(r.unchecked, [{ claimHash: claimHashOf(B), hash: U1.hash }]);
    assert.deepEqual([r.cached, r.fresh], [0, 2]);
  });

  it("G8 every call throws -> all calls attempted, scores empty, engine_failure", async () => {
    let calls = 0;
    const r = await judgeGrid(
      opts({
        batchSize: 1,
        createEngine: () => ({
          run: async () => { calls++; throw new Error("down"); },
        }),
      }),
      [{ units: [U1, U2], claims: [A, B] }],
    );
    assert.equal(calls, 4);
    assert.equal(r.scores.size, 0);
    assert.deepEqual([r.cached, r.fresh], [0, 0]);
    assert.equal(r.interruption?.reason, "engine_failure");
    assert.deepEqual(r.unchecked, [
      { claimHash: claimHashOf(A), hash: U1.hash },
      { claimHash: claimHashOf(B), hash: U1.hash },
      { claimHash: claimHashOf(A), hash: U2.hash },
      { claimHash: claimHashOf(B), hash: U2.hash },
    ]);
  });

  it("G9 abort mid-run -> finished kept, rest unchecked, cancelled; rerun judges only the rest", async () => {
    const ctl = new AbortController();
    let calls = 0;
    const engine: ClaimEngine = {
      run: async (rows) => {
        calls++;
        if (calls === 2) ctl.abort();
        return rows.map(() => 0.6);
      },
    };
    const r = await judgeGrid(opts({ workers: 1, batchSize: 1, signal: ctl.signal, createEngine: () => engine }), [{ units: [U1, U2, U3, U4], claims: [A] }]);
    assert.equal(r.interruption?.reason, "cancelled");
    assert.equal(calls, 2);
    assert.deepEqual([r.cached, r.fresh], [0, 2]);
    assert.deepEqual(r.unchecked, [
      { claimHash: claimHashOf(A), hash: U3.hash },
      { claimHash: claimHashOf(A), hash: U4.hash },
    ]);
    let rerunCalls = 0;
    const r2 = await judgeGrid(
      opts({ batchSize: 1, createEngine: () => ({ run: async (rows) => { rerunCalls++; return rows.map(() => 0.6); } }) }),
      [{ units: [U1, U2, U3, U4], claims: [A] }],
    );
    assert.equal(rerunCalls, 2);
    assert.deepEqual([r2.cached, r2.fresh], [2, 2]);
    assert.equal(r2.interruption, null);
  });

  it("G10 maxFresh=4 -> budget, remaining unchecked in order, rerun completes", async () => {
    let calls = 0;
    const mk = (): ClaimEngine => ({
      run: async (rows) => { calls++; return rows.map(() => 0.6); },
    });
    const bundles = [{ units: [U1, U2, U3], claims: [A, B] }];
    const r = await judgeGrid(opts({ maxFresh: 4, batchSize: 2, createEngine: mk }), bundles);
    assert.equal(r.interruption?.reason, "budget");
    assert.deepEqual([r.cached, r.fresh], [0, 4]);
    assert.equal(calls, 2);
    assert.deepEqual(r.unchecked, [
      { claimHash: claimHashOf(A), hash: U3.hash },
      { claimHash: claimHashOf(B), hash: U3.hash },
    ]);
    const r2 = await judgeGrid(opts({ createEngine: mk }), bundles);
    assert.deepEqual([r2.cached, r2.fresh], [4, 2]);
    assert.equal(r2.interruption, null);
  });

  for (const [label, bad] of [
    ["too few scores", [0.9]],
    ["too many scores", [0.9, 0.9, 0.9, 0.9]],
    ["a NaN score", [0.9, Number.NaN, 0.9]],
    ["an infinite score", [0.9, Number.POSITIVE_INFINITY, 0.9]],
    ["a score above 1", [0.9, 1.5, 0.9]],
    ["a non-number", [0.9, "0.9", 0.9]],
  ] as const) {
    it(`G11 ${label} fails that call's cells, nothing persisted`, async () => {
      const r = await judgeGrid(opts({ createEngine: () => ({ run: async () => [...bad] as unknown as number[] }) }), [{ units: [U1], claims: [A, B, C] }]);
      assert.equal(r.interruption?.reason, "engine_failure");
      assert.equal(r.scores.size, 0);
      assert.deepEqual([r.cached, r.fresh], [0, 0]);
      assert.equal(r.unchecked.length, 3);
      assert.equal(cachedJudgments(db, A, V2, [U1.hash]).size, 0);
    });
  }

  it("G12 paperVerdict (OR; 0.99 exactly supports; below bar + unscored is incomplete; empty is unsupported)", async () => {
    assert.equal(paperVerdict([U1.hash, U2.hash], (h) => (h === U1.hash ? 0.99 : 0.1), 0.99), "supported");
    assert.equal(paperVerdict([U1.hash, U2.hash], (h) => (h === U1.hash ? 0.1 : undefined), 0.99), "incomplete");
    assert.equal(paperVerdict([U1.hash, U2.hash], () => 0.1, 0.99), "unsupported");
    assert.equal(paperVerdict([], () => undefined, 0.99), "unsupported");
  });

  it("G13 claimVerdict table", async () => {
    assert.equal(claimVerdict(["supported", "supported"]), "supported");
    assert.equal(claimVerdict(["supported", "incomplete"]), "incomplete");
    assert.equal(claimVerdict(["incomplete", "incomplete"]), "incomplete");
    assert.equal(claimVerdict(["supported", "unsupported"]), "unsupported");
    assert.equal(claimVerdict([]), "unsupported");
  });
});
