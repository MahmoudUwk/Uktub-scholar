/**
 * Phase V2: keyed question packs over the System One HTTP engines.
 * Offline: stub fetch answers per request key; no provider quota spent.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry } from "../src/core/registry.ts";
import { CancelledError, EngineError, openrouterDecisionsEngine, systemoneEndpointEngine } from "../src/core/verify/claim.ts";
import { createConfiguredEngine } from "../src/core/verify/engines.ts";
import { judgePassages } from "../src/core/verify/judge.ts";
import { saveJudgments } from "../src/core/verify/store.ts";
import { criteriaQuestion } from "../src/core/verify/wording.ts";

const KEY = "k-test-pack-key";
const HOSTED_MODEL = "vllm-sr/d3-mini";

interface Seen {
  body: { state: string; questions: Record<string, unknown>; states?: Record<string, { state: string; questions: Record<string, unknown> }>; model?: string };
}

const te = new TextEncoder();
const estimate = (state: string, questions: Record<string, unknown>): number =>
  Object.values(questions).reduce((n: number, q: unknown) => n + te.encode(state).length + te.encode(JSON.stringify(q)).length, 0);

/** Stub fetch: per-request answers from `answer`, records bodies. */
const stub = (seen: Seen[], answer: (body: Seen["body"], call: number) => { status: number; payload: unknown }) => {
  let calls = 0;
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as Seen["body"];
    seen.push({ body });
    const { status, payload } = answer(body, calls++);
    return new Response(typeof payload === "string" ? payload : JSON.stringify(payload), { status });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls: () => calls };
};

const okAnswers = (questions: Record<string, unknown>, score: (key: string) => number): unknown => {
  const answers: Record<string, { noul: number }> = {};
  for (const key of Object.keys(questions).reverse()) answers[key] = { noul: score(key) };
  return { answers, model: HOSTED_MODEL };
};

const hosted = (fetchImpl: typeof fetch) => createConfiguredEngine({ UKTUB_VERIFY_API_KEY: KEY }, "hosted", { fetchImpl });

describe("V2 keyed packs: grouping and wire keys", () => {
  it("1 same state, 5 rows -> 1 POST keyed q1..q5; reversed answers map back in row order", async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(seen, (body) => ({ status: 200, payload: okAnswers(body.questions, (k) => Number(k.slice(1)) / 10) }));
    const out = await hosted(fetchImpl).run([
      { state: "S", instructions: "c0" },
      { state: "S", instructions: "c1" },
      { state: "S", instructions: "c2" },
      { state: "S", instructions: "c3" },
      { state: "S", instructions: "c4" },
    ]);
    assert.deepEqual(out, [0.1, 0.2, 0.3, 0.4, 0.5]);
    assert.equal(seen.length, 1);
    assert.deepEqual(Object.keys(seen[0].body.questions), ["q1", "q2", "q3", "q4", "q5"]);
    assert.ok(seen.every((s) => s.body.state === "S"));
    assert.deepEqual((seen[0].body.questions as Record<string, unknown>).q1, criteriaQuestion("c0", "criteria"));
  });

  it("2 rows S1,S2,S1 -> 1 POST: top-level S1 with q1,q2 and states.s2 = S2 with q1", async () => {
    const seen: Seen[] = [];
    const scores: Record<string, number> = { a: 0.1, b: 0.2, c: 0.3 };
    const scoreOf = (q: unknown): number => {
      const instr = (q as { instructions: string }).instructions;
      return scores[Object.keys(scores).find((c) => instr.includes(`"${c}"`))!];
    };
    const { fetchImpl } = stub(seen, (body) => ({
      status: 200,
      payload: {
        answers: Object.fromEntries(Object.entries(body.questions).map(([k, q]) => [k, { noul: scoreOf(q) }])),
        states: Object.fromEntries(
          Object.entries(body.states ?? {}).map(([name, e]) => [
            name,
            { answers: Object.fromEntries(Object.entries((e as { questions: Record<string, unknown> }).questions).map(([k, q]) => [k, { noul: scoreOf(q) }])) },
          ]),
        ),
        model: HOSTED_MODEL,
      },
    }));
    const out = await hosted(fetchImpl).run([
      { state: "S1", instructions: "a" },
      { state: "S2", instructions: "b" },
      { state: "S1", instructions: "c" },
    ]);
    assert.deepEqual(out, [0.1, 0.2, 0.3]);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].body.state, "S1");
    assert.deepEqual(Object.keys(seen[0].body.questions), ["q1", "q2"]);
    assert.deepEqual(Object.keys(seen[0].body.states ?? {}), ["s2"]);
    const s2 = (seen[0].body.states as Record<string, { state: string; questions: Record<string, unknown> }>)["s2"];
    assert.equal(s2.state, "S2");
    assert.deepEqual(Object.keys(s2.questions), ["q1"]);
  });

  it("3a hosted 25 rows of 100-char state -> [20,5]", async () => {
    const seen: Seen[] = [];
    const state = "x".repeat(100);
    const { fetchImpl } = stub(seen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    const out = await hosted(fetchImpl).run(Array.from({ length: 25 }, (_, i) => ({ state, instructions: `claim-${i}` })));
    assert.deepEqual(out, Array(25).fill(0.5));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [20, 5]);
    for (const s of seen) {
      assert.ok(Object.keys(s.body.questions).length <= 20);
      assert.ok(estimate(s.body.state, s.body.questions) <= 120_000);
    }
  });

  it("3b hosted 5 rows of 32,000-char ASCII state -> [3,2]", async () => {
    const seen: Seen[] = [];
    const state = "y".repeat(32_000);
    const { fetchImpl } = stub(seen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    await hosted(fetchImpl).run(Array.from({ length: 5 }, (_, i) => ({ state, instructions: `claim-${i}` })));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [3, 2]);
    for (const s of seen) assert.ok(estimate(s.body.state, s.body.questions) <= 120_000);
  });

  it("3c hosted 5 rows of 20,000xU+00E9 (40,000 bytes) -> [2,2,1]", async () => {
    const seen: Seen[] = [];
    const state = "é".repeat(20_000);
    assert.equal(te.encode(state).length, 40_000);
    const { fetchImpl } = stub(seen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    await hosted(fetchImpl).run(Array.from({ length: 5 }, (_, i) => ({ state, instructions: `claim-${i}` })));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [2, 2, 1]);
    for (const s of seen) assert.ok(estimate(s.body.state, s.body.questions) <= 120_000);
  });

  it("4 openrouter 25 rows of 30,000-char state -> [20,5]; pin: llama-cpp 3 same-state rows -> 3 POSTs each key c", async () => {
    const seen: Seen[] = [];
    const state = "z".repeat(30_000);
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Seen["body"];
      seen.push({ body });
      const answers: Record<string, { noul: number }> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { noul: 0.5 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = openrouterDecisionsEngine({ env: { OPENROUTER_API_KEY: KEY, UKTUB_OPENROUTER_MIN_INTERVAL_MS: "0" }, model: "m", fetchImpl, pack: { maxQuestions: 20 } });
    await e.run(Array.from({ length: 25 }, (_, i) => ({ state, instructions: `claim-${i}` })));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [20, 5]);

    const cppSeen: Seen[] = [];
    const { fetchImpl: cppFetch } = stub(cppSeen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    const cpp = systemoneEndpointEngine({ url: "http://127.0.0.1:8080/v1/systemone", label: "llama-cpp", fetchImpl: cppFetch });
    await cpp.run([
      { state: "S", instructions: "a" },
      { state: "S", instructions: "b" },
      { state: "S", instructions: "c" },
    ]);
    assert.equal(cppSeen.length, 3);
    for (const s of cppSeen) assert.deepEqual(Object.keys(s.body.questions), ["c"]);
  });
});

describe("V2 keyed packs: per-key and transport failures", () => {
  it("5 per-key error in a 200 -> RowFailure for that row only; 1 POST, no retry, no split", async () => {
    const seen: Seen[] = [];
    const { fetchImpl, calls } = stub(seen, () => ({
      status: 200,
      payload: { answers: { q1: { noul: 0.995 }, q2: { error: "invalid_question" }, q3: { noul: 0.2 } }, model: HOSTED_MODEL },
    }));
    const out = await hosted(fetchImpl).run([
      { state: "S", instructions: "a" },
      { state: "S", instructions: "b" },
      { state: "S", instructions: "c" },
    ]);
    assert.equal(out[0], 0.995);
    assert.match((out[1] as unknown as { failed: string }).failed, /invalid_question/);
    assert.equal(out[2], 0.2);
    assert.equal(calls(), 1);
    assert.equal(seen.length, 1);
  });

  it("6 pin: answers for q1 only of 2 rejects EngineError", async () => {
    const { fetchImpl } = stub([], () => ({ status: 200, payload: { answers: { q1: { noul: 0.5 } }, model: HOSTED_MODEL } }));
    await assert.rejects(hosted(fetchImpl).run([
      { state: "S", instructions: "a" },
      { state: "S", instructions: "b" },
    ]), EngineError);
  });

  it("7 request_too_long splits 5 -> 3|2, then 3 -> 2|1; final scores in row order", async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(seen, (body) => {
      if (Object.keys(body.questions).length > 2) return { status: 400, payload: { error: { code: "request_too_long" } } };
      const answers: Record<string, { noul: number }> = {};
      for (const [k, q] of Object.entries(body.questions)) {
        const m = /claim-(\d)/.exec((q as { instructions: string }).instructions);
        answers[k] = { noul: (Number(m![1]) + 1) / 8 };
      }
      return { status: 200, payload: { answers, model: HOSTED_MODEL } };
    });
    const out = await hosted(fetchImpl).run(Array.from({ length: 5 }, (_, i) => ({ state: "S", instructions: `claim-${i}` })));
    assert.deepEqual(out, [0.125, 0.25, 0.375, 0.5, 0.625]);
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [5, 3, 2, 1, 2]);
  });

  it("7b single-question request_too_long -> RowFailure", async () => {
    const { fetchImpl, calls } = stub([], () => ({ status: 400, payload: { error: { code: "request_too_long" } } }));
    const out = await hosted(fetchImpl).run([{ state: "S", instructions: "a" }]);
    assert.match((out[0] as unknown as { failed: string }).failed, /request_too_long/);
    assert.equal(calls(), 1);
  });

  it("7c pin: 400 state_too_long -> no split, EngineError, 1 POST", async () => {
    const { fetchImpl, calls } = stub([], () => ({ status: 400, payload: { error: { code: "state_too_long" } } }));
    await assert.rejects(hosted(fetchImpl).run([{ state: "S", instructions: "a" }]), EngineError);
    assert.equal(calls(), 1);
  });

  it("8a 503,503,200 -> 3 POSTs, sleeps [1000,4000], score", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      if (n <= 2) return new Response("busy", { status: 503 });
      return new Response(JSON.stringify({ answers: { c: { noul: 0.7 } }, model: HOSTED_MODEL }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: `Bearer ${KEY}`,
      model: HOSTED_MODEL,
      fetchImpl,
      sleepImpl: async (ms: number) => { sleeps.push(ms); },
    });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.7]);
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [1000, 4000]);
  });

  it("8b 503 x3 -> RowFailure /503/, exactly 3 POSTs, no key in text", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const e = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: `Bearer ${KEY}`,
      model: HOSTED_MODEL,
      fetchImpl,
      sleepImpl: async (ms: number) => { sleeps.push(ms); },
    });
    const out = await e.run([{ state: "s", instructions: "c" }]);
    assert.match((out[0] as unknown as { failed: string }).failed, /503/);
    assert.ok(!(out[0] as unknown as { failed: string }).failed.includes(KEY));
    assert.equal(n, 3);
    assert.deepEqual(sleeps, [1000, 4000]);
  });

  it("8c TypeError then 200 -> sleeps [1000]", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = (async () => {
      if (++n === 1) throw new TypeError("fetch failed");
      return new Response(JSON.stringify({ answers: { c: { noul: 0.6 } }, model: HOSTED_MODEL }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: `Bearer ${KEY}`,
      model: HOSTED_MODEL,
      fetchImpl,
      sleepImpl: async (ms: number) => { sleeps.push(ms); },
    });
    assert.deepEqual(await e.run([{ state: "s", instructions: "c" }]), [0.6]);
    assert.deepEqual(sleeps, [1000]);
  });

  it("8d abort inside the first retry sleep -> CancelledError, 1 POST", async () => {
    let n = 0;
    const controller = new AbortController();
    const fetchImpl = (async () => {
      n++;
      return new Response("busy", { status: 503 });
    }) as unknown as typeof fetch;
    const e = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: `Bearer ${KEY}`,
      model: HOSTED_MODEL,
      fetchImpl,
      sleepImpl: async (_ms: number) => { controller.abort(); },
    });
    await assert.rejects(e.run([{ state: "s", instructions: "c" }], { signal: controller.signal }), CancelledError);
    assert.equal(n, 1);
  });

  it("8e other 4xx are never retried", async () => {
    const sleeps: number[] = [];
    const { fetchImpl, calls } = stub([], () => ({ status: 400, payload: "bad request" }));
    const e = systemoneEndpointEngine({
      url: "https://decision.vllm-sr.ai/v1/systemone",
      label: "hosted",
      apiKey: `Bearer ${KEY}`,
      model: HOSTED_MODEL,
      fetchImpl,
      sleepImpl: async (ms: number) => { sleeps.push(ms); },
    });
    await assert.rejects(e.run([{ state: "s", instructions: "c" }]), EngineError);
    assert.equal(calls(), 1);
    assert.deepEqual(sleeps, []);
  });
});

describe("V2 protocol and cache identity", () => {
  const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;

  it("9 protocol v2 for hosted, openrouter and llama-cpp; eos and eos-onnx stay decision2-noul-v1", async () => {
    const { resolveEngineIdentity } = await import("../src/core/verify/engines.ts");
    assert.deepEqual(await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k" }, "hosted", { fetchImpl: notFound }), {
      model: "hosted:vllm-sr/d3-mini",
      protocol: "systemone-noul-criteria-v2",
    });
    assert.deepEqual(await resolveEngineIdentity({ UKTUB_OPENROUTER_MODEL: "m" }, "openrouter"), {
      model: "openrouter:m",
      protocol: "systemone-noul-criteria-v2",
    });
    const listed = (async () => new Response(JSON.stringify({ data: [{ id: "m.gguf" }] }), { status: 200 })) as unknown as typeof fetch;
    assert.deepEqual(await resolveEngineIdentity({ UKTUB_VERIFY_URL: "http://127.0.0.1:8080" }, "llama-cpp", { fetchImpl: listed }), {
      model: "llama-cpp:m.gguf",
      protocol: "systemone-noul-criteria-v2",
    });
    assert.deepEqual(await resolveEngineIdentity({}, "eos"), {
      model: "eos:vllm-sr/Decision-2.0-Eos-0.8B@3594047d69f4",
      protocol: "decision2-noul-v1",
    });
    assert.equal((await resolveEngineIdentity({ UKTUB_EOS_ONNX_DIR: "/models/eos-onnx" }, "eos-onnx"))!.protocol, "decision2-noul-v1");
  });

  it("10 a row saved under the literal v1 identity is not reused under the resolved identity", async () => {
    let root = "";
    let db: DatabaseSync | null = null;
    try {
      root = mkdtempSync(join(tmpdir(), "uktub-v2id-"));
      db = createRegistry(root);
      const claim = "Cells age faster at high temperature.";
      saveJudgments(db, claim, { model: "hosted:vllm-sr/d3-mini", protocol: "systemone-noul-criteria-v1" }, [
        { passageHash: "h1", pTrue: 0.99 },
        { passageHash: "h2", pTrue: 0.01 },
      ], new Date("2026-10-04T00:00:00Z"));
      const { resolveEngineIdentity } = await import("../src/core/verify/engines.ts");
      const identity = await resolveEngineIdentity({ UKTUB_VERIFY_API_KEY: "k" }, "hosted", { fetchImpl: notFound });
      let built = 0;
      const r = await judgePassages(
        {
          db, queue: new WriteQueue(), now: () => new Date("2026-10-04T00:00:00Z"), identity,
          createEngine: () => { built++; return { run: async (rows) => rows.map(() => 0.5) }; },
          workers: 1, batchSize: 8, maxFresh: 100,
        },
        claim,
        [{ text: "t1", hash: "h1" }, { text: "t2", hash: "h2" }],
      );
      assert.equal(built, 1);
      assert.deepEqual([r.cached, r.fresh], [0, 2]);
    } finally {
      db?.close();
      if (root !== "") rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("V2b multi-state packs", () => {
  /** Stub fetch answering every entry (top-level + states) by key order. */
  const multiStub = (seen: Seen[], scoreOf: (state: string, key: string) => number) =>
    stub(seen, (body) => {
      const answerEntry = (questions: Record<string, unknown>, state: string): Record<string, { noul: number }> =>
        Object.fromEntries(Object.keys(questions).map((k) => [k, { noul: scoreOf(state, k) }]));
      return {
        status: 200,
        payload: {
          answers: answerEntry(body.questions, body.state),
          states: Object.fromEntries(Object.entries(body.states ?? {}).map(([name, e]) => [name, { answers: answerEntry(e.questions, e.state) }])),
          model: HOSTED_MODEL,
        },
      };
    });

  const inputsOf = (body: Seen["body"]): number => 1 + Object.keys(body.states ?? {}).length;

  const checkPack = (body: Seen["body"]): void => {
    const total = Object.keys(body.questions).length + Object.values(body.states ?? {}).reduce((n, e) => n + Object.keys(e.questions).length, 0);
    assert.ok(total <= 20, `more than 20 questions in one pack: ${total}`);
    assert.ok(inputsOf(body) <= 9, `more than 9 inputs in one pack: ${inputsOf(body)}`);
    assert.ok(estimate(body.state, body.questions) + Object.values(body.states ?? {}).reduce((n, e) => n + estimate(e.state, e.questions), 0) <= 120_000);
  };

  it("12 rows over 12 distinct short states -> 2 POSTs with 9 and 3 inputs", async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = multiStub(seen, () => 0.5);
    const out = await hosted(fetchImpl).run(Array.from({ length: 12 }, (_, i) => ({ state: `S${i}`, instructions: `claim-${i}` })));
    assert.deepEqual(out, Array(12).fill(0.5));
    assert.equal(seen.length, 2);
    assert.equal(inputsOf(seen[0].body), 9);
    assert.equal(inputsOf(seen[1].body), 3);
    assert.equal(seen[0].body.state, "S0");
    assert.deepEqual(Object.keys(seen[0].body.states ?? {}), ["s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]);
    assert.equal(seen[1].body.state, "S9");
    assert.deepEqual(Object.keys(seen[1].body.states ?? {}), ["s2", "s3"]);
    for (const s of seen) checkPack(s.body);
  });

  it("pin: 25 rows of one state -> [20,5]", async () => {
    const seen: Seen[] = [];
    const state = "x".repeat(100);
    const { fetchImpl } = stub(seen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    await hosted(fetchImpl).run(Array.from({ length: 25 }, (_, i) => ({ state, instructions: `claim-${i}` })));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length), [20, 5]);
    for (const s of seen) {
      assert.equal(inputsOf(s.body), 1);
      checkPack(s.body);
    }
  });

  it("byte cap binds across states: 5 rows of 32,000-char ASCII in distinct states -> [3,2]", async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = multiStub(seen, () => 0.5);
    await hosted(fetchImpl).run(Array.from({ length: 5 }, (_, i) => ({ state: `${`S${i}`}:${"y".repeat(32_000)}`, instructions: `claim-${i}` })));
    assert.deepEqual(seen.map((s) => Object.keys(s.body.questions).length + Object.values(s.body.states ?? {}).reduce((n, e) => n + Object.keys(e.questions).length, 0)), [3, 2]);
    for (const s of seen) checkPack(s.body);
  });

  it("answers for states.s3 returned before s2 still map back by key, never by position", async () => {
    const seen: Seen[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Seen["body"];
      seen.push({ body });
      return new Response(
        JSON.stringify({
          answers: { q1: { noul: 0.1 } },
          states: { s3: { answers: { q1: { noul: 0.3 } } }, s2: { answers: { q1: { noul: 0.2 } } } },
          model: HOSTED_MODEL,
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const out = await hosted(fetchImpl).run([
      { state: "S1", instructions: "a" },
      { state: "S2", instructions: "b" },
      { state: "S3", instructions: "c" },
    ]);
    assert.deepEqual(out, [0.1, 0.2, 0.3]);
    assert.equal(seen.length, 1);
  });

  it("a missing states entry is a malformed response: EngineError", async () => {
    const { fetchImpl } = stub([], () => ({
      status: 200,
      payload: { answers: { q1: { noul: 0.1 } }, states: { s2: { answers: { q1: { noul: 0.2 } } } }, model: HOSTED_MODEL },
    }));
    await assert.rejects(
      hosted(fetchImpl).run([
        { state: "S1", instructions: "a" },
        { state: "S2", instructions: "b" },
        { state: "S3", instructions: "c" },
      ]),
      EngineError,
    );
  });

  it("a per-key error inside a states entry fails only that row", async () => {
    const seen: Seen[] = [];
    const { fetchImpl, calls } = stub(seen, () => ({
      status: 200,
      payload: {
        answers: { q1: { noul: 0.9 } },
        states: { s2: { answers: { q1: { error: "invalid_question" } } }, s3: { answers: { q1: { noul: 0.2 } } } },
        model: HOSTED_MODEL,
      },
    }));
    const out = await hosted(fetchImpl).run([
      { state: "S1", instructions: "a" },
      { state: "S2", instructions: "b" },
      { state: "S3", instructions: "c" },
    ]);
    assert.equal(out[0], 0.9);
    assert.match((out[1] as unknown as { failed: string }).failed, /invalid_question/);
    assert.equal(out[2], 0.2);
    assert.equal(calls(), 1);
  });

  it("request_too_long on a multi-state pack splits in pack order", async () => {
    const seen: Seen[] = [];
    const { fetchImpl } = stub(seen, (body) => {
      const total = Object.keys(body.questions).length + Object.values(body.states ?? {}).reduce((n, e) => n + Object.keys(e.questions).length, 0);
      if (total > 2) return { status: 400, payload: { error: { code: "request_too_long" } } };
      const answers: Record<string, { noul: number }> = {};
      const one = (questions: Record<string, unknown>): void => {
        for (const [k, q] of Object.entries(questions)) {
          const m = /claim-(\d)/.exec((q as { instructions: string }).instructions);
          answers[k] = { noul: (Number(m![1]) + 1) / 8 };
        }
      };
      one(body.questions);
      return {
        status: 200,
        payload: {
          answers,
          states: Object.fromEntries(
            Object.entries(body.states ?? {}).map(([name, e]) => {
              const sub: Record<string, { noul: number }> = {};
              for (const [k, q] of Object.entries(e.questions)) {
                const m = /claim-(\d)/.exec((q as { instructions: string }).instructions);
                sub[k] = { noul: (Number(m![1]) + 1) / 8 };
              }
              return [name, { answers: sub }];
            }),
          ),
          model: HOSTED_MODEL,
        },
      };
    });
    const out = await hosted(fetchImpl).run([
      { state: "S1", instructions: "claim-0" },
      { state: "S1", instructions: "claim-1" },
      { state: "S2", instructions: "claim-2" },
      { state: "S2", instructions: "claim-3" },
    ]);
    assert.deepEqual(out, [0.125, 0.25, 0.375, 0.5]);
    assert.deepEqual(
      seen.map((s) => Object.keys(s.body.questions).length + Object.values(s.body.states ?? {}).reduce((n, e) => n + Object.keys(e.questions).length, 0)),
      [4, 2, 2],
    );
  });

  it("too_many_states is a fatal EngineError (a client bug), not a split", async () => {
    const { fetchImpl, calls } = stub([], () => ({ status: 400, payload: { error: { code: "too_many_states" } } }));
    await assert.rejects(hosted(fetchImpl).run([{ state: "S", instructions: "a" }]), EngineError);
    assert.equal(calls(), 1);
  });

  it("openrouter and llama-cpp never send states", async () => {
    const seen: Seen[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Seen["body"];
      seen.push({ body });
      const answers: Record<string, { noul: number }> = {};
      for (const k of Object.keys(body.questions)) answers[k] = { noul: 0.5 };
      return new Response(JSON.stringify({ answers }), { status: 200 });
    }) as unknown as typeof fetch;
    const e = openrouterDecisionsEngine({ env: { OPENROUTER_API_KEY: KEY, UKTUB_OPENROUTER_MIN_INTERVAL_MS: "0" }, model: "m", fetchImpl, pack: { maxQuestions: 20 } });
    await e.run([
      { state: "S1", instructions: "a" },
      { state: "S2", instructions: "b" },
      { state: "S3", instructions: "c" },
    ]);
    assert.equal(seen.length, 3);
    for (const s of seen) {
      assert.ok(!("states" in s.body));
      assert.deepEqual(Object.keys(s.body.questions), ["c"]);
    }

    const cppSeen: Seen[] = [];
    const { fetchImpl: cppFetch } = stub(cppSeen, (body) => ({ status: 200, payload: okAnswers(body.questions, () => 0.5) }));
    const cpp = systemoneEndpointEngine({ url: "http://127.0.0.1:8080/v1/systemone", label: "llama-cpp", fetchImpl: cppFetch });
    await cpp.run([
      { state: "S1", instructions: "a" },
      { state: "S2", instructions: "b" },
    ]);
    assert.equal(cppSeen.length, 2);
    for (const s of cppSeen) assert.ok(!("states" in s.body));
  });
});
