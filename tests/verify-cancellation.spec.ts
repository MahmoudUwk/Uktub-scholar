/**
 * Hosted cancellation through the real transport (offline): an aborted host
 * signal stops the current fetch and starts no further work; the judge
 * reports `cancelled` and writes nothing; document mode stops between units.
 * Fake engines/HTTP servers only — no provider quota.
 */
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { WriteQueue } from "../src/core/queue.ts";
import { createRegistry, registerPaper } from "../src/core/registry.ts";
// Side-effect first: document.ts and tools/verify.ts import each other, and
// the cycle only resolves when entered here (as in the product and doc spec).
import "../src/core/tools/verify.ts";
import type { ToolContext } from "../src/core/tools/context.ts";
import { openrouterDecisionsEngine, systemoneEndpointEngine } from "../src/core/verify/claim.ts";
import { documentWorkflow } from "../src/core/verify/document.ts";
import { judgePassages } from "../src/core/verify/judge.ts";
import { publishSource } from "../src/core/verify/store.ts";

/** Cancellation surfaces as an error named CancelledError (never EngineError). */
const isCancelled = (e: unknown): boolean => e instanceof Error && e.name === "CancelledError";

const URL = "https://decision.vllm-sr.ai/v1/systemone";
const NOW = () => new Date("2026-10-04T12:00:00Z");

const cancelledErr = (): Error => {
  const c = new Error("the request was cancelled");
  c.name = "CancelledError";
  return c;
};

const abortErr = (): Error => {
  const e = new Error("This operation was aborted");
  e.name = "AbortError";
  return e;
};

const okBody = (p = 0.5): unknown => ({ answers: { c: { noul: p } }, model: "vllm-sr/d3-mini" });

describe("cancellation: hosted engine through the real transport", () => {
  it("abort during a pending fetch rejects and starts no further rows", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      return new Promise<Response>((_resolve, reject) => {
        const s = init?.signal;
        if (s?.aborted) {
          reject(abortErr());
          return;
        }
        s?.addEventListener("abort", () => reject(abortErr()), { once: true });
      });
    }) as unknown as typeof fetch;
    const engine = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const rows = [
      { state: "s1", instructions: "c1" },
      { state: "s2", instructions: "c2" },
    ];
    // Guard: a non-observant engine would hang here (its own 120 s timeout);
    // fail fast instead of waiting for it.
    const outcome = await Promise.race([
      engine.run(rows, { signal: controller.signal }).then(
        () => "resolved",
        (e: unknown) => e,
      ),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 2000)),
    ]);
    assert.ok(outcome instanceof Error && isCancelled(outcome), `expected a CancelledError, got ${String(outcome)}`);
    assert.equal(calls, 1, "the second row is never fetched after abort");
    assert.ok(controller.signal.aborted);
  });

  it("abort-before-start makes zero fetch calls", async () => {
    let calls = 0;
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return new Response(JSON.stringify(okBody()), { status: 200 });
    }) as unknown as typeof fetch;
    const engine = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(engine.run([{ state: "s", instructions: "c" }], { signal: controller.signal }), isCancelled);
    assert.equal(calls, 0);
  });

  it("abort during 429 backoff rejects with zero followup HTTP calls", async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      return new Response("limited", { status: 429, headers: { "retry-after": "30" } });
    }) as unknown as typeof fetch;
    // Abort lands while the retry waits; the wait itself resolves so a
    // non-observant loop would continue to a second HTTP call.
    const sleepImpl = async (ms: number): Promise<void> => {
      assert.ok(ms > 0);
      controller.abort();
    };
    const engine = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl, sleepImpl });
    await assert.rejects(engine.run([{ state: "s", instructions: "c" }], { signal: controller.signal }), isCancelled);
    assert.equal(calls, 1, "no followup HTTP call after abort during backoff");
  });

  it("openrouter throttle wait observes abort", async () => {
    let calls = 0;
    const controller = new AbortController();
    const fetchImpl = (async (): Promise<Response> => {
      calls++;
      controller.abort();
      return new Response(JSON.stringify({ answers: { c: { noul: 0.7 } } }), { status: 200 });
    }) as unknown as typeof fetch;
    const engine = openrouterDecisionsEngine({
      env: { OPENROUTER_API_KEY: "k-test", UKTUB_OPENROUTER_MIN_INTERVAL_MS: "50" },
      fetchImpl,
      model: "m",
    });
    await assert.rejects(
      engine.run(
        [
          { state: "s1", instructions: "c1" },
          { state: "s2", instructions: "c2" },
        ],
        { signal: controller.signal },
      ),
      isCancelled,
    );
    assert.equal(calls, 1, "the second row never starts after abort");
  });

  it("non-cancelled hosted path is unchanged: body, retries, scores", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const sleeps: number[] = [];
    const queue: { status: number }[] = [{ status: 429 }, { status: 200 }];
    const fetchImpl = (async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      const next = queue.shift() ?? { status: 200 };
      return new Response(JSON.stringify(okBody(0.8)), { status: next.status });
    }) as unknown as typeof fetch;
    const engine = systemoneEndpointEngine({
      url: URL,
      label: "hosted",
      apiKey: "k-secret",
      model: "vllm-sr/d3-mini",
      fetchImpl,
      sleepImpl: async (ms: number) => {
        sleeps.push(ms);
      },
    });
    assert.deepEqual(await engine.run([{ state: "s", instructions: "c" }]), [0.8]);
    assert.equal(calls.length, 2, "one attempt plus one retry");
    assert.equal(sleeps.length, 1);
    const sent = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    assert.deepEqual(Object.keys(sent).sort(), ["model", "questions", "state"]);
    assert.equal(sent.model, "vllm-sr/d3-mini");
    assert.equal((calls[0].init?.headers as Record<string, string>).authorization, "Bearer k-secret");
  });
});

describe("cancellation: judge reports cancelled and writes nothing", () => {
  let root: string;
  let db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-vcancel-"));
    db = createRegistry(root);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const judgeDb = (): { db: DatabaseSync; queue: { runExclusive<T>(fn: () => T | Promise<T>): Promise<T> } } => ({
    db,
    queue: new WriteQueue(),
  });

  it("mid-flight abort reports cancelled with everything unchecked and caches nothing", { timeout: 5000 }, async () => {
    // A fake engine that only settles via the signal it is given.
    let runs = 0;
    const pendingEngine = {
      run: (_rows: { state: string; instructions: string }[], opts?: { signal?: AbortSignal }): Promise<number[]> => {
        runs++;
        return new Promise<number[]>((_resolve, reject) => {
          opts?.signal?.addEventListener("abort", () => reject(cancelledErr()), { once: true });
        });
      },
    };
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const { queue } = judgeDb();
    const passages = [
      { text: "passage one about cells", hash: "h1" },
      { text: "passage two about cells", hash: "h2" },
    ];
    const out = await judgePassages(
      {
        db,
        queue,
        now: NOW,
        identity: { model: "test-model", protocol: "test-protocol" },
        createEngine: () => pendingEngine,
        workers: 1,
        batchSize: 1,
        maxFresh: 10,
        signal: controller.signal,
      },
      "claim about cells",
      passages,
    );
    assert.equal(out.interruption?.reason, "cancelled");
    assert.notEqual(out.interruption?.reason, "engine_failure");
    assert.deepEqual(out.unchecked, ["h1", "h2"]);
    assert.equal(out.scores.size, 0);
    // Nothing was cached: a clean re-run judges everything fresh.
    let freshRuns = 0;
    const out2 = await judgePassages(
      {
        db,
        queue,
        now: NOW,
        identity: { model: "test-model", protocol: "test-protocol" },
        createEngine: () => ({
          run: async (rows: { state: string; instructions: string }[]) => {
            freshRuns++;
            return rows.map(() => 0.9);
          },
        }),
        workers: 1,
        batchSize: 8,
        maxFresh: 10,
      },
      "claim about cells",
      passages,
    );
    assert.equal(out2.interruption, null);
    assert.equal(out2.fresh, 2, "no cancelled judgment was saved");
    assert.equal(freshRuns, 1);
    assert.ok(runs >= 1);
  });

  it("abort-before-start starts no engine work and reports cancelled", async () => {
    let runs = 0;
    const controller = new AbortController();
    controller.abort();
    const { queue } = judgeDb();
    const out = await judgePassages(
      {
        db,
        queue,
        now: NOW,
        identity: { model: "test-model", protocol: "test-protocol" },
        createEngine: () => ({
          run: async (rows: { state: string; instructions: string }[]) => {
            runs++;
            return rows.map(() => 0.9);
          },
        }),
        workers: 2,
        batchSize: 1,
        maxFresh: 10,
        signal: controller.signal,
      },
      "claim about cells",
      [{ text: "passage one about cells", hash: "h1" }],
    );
    assert.equal(out.interruption?.reason, "cancelled");
    assert.deepEqual(out.unchecked, ["h1"]);
    assert.equal(runs, 0);
  });

  it("clean judge path is unchanged", async () => {
    const { queue } = judgeDb();
    const passages = [{ text: "passage one about cells", hash: "h1" }];
    const mk = (): { run: (rows: { state: string; instructions: string }[]) => Promise<number[]> } => ({
      run: async (rows) => rows.map(() => 0.95),
    });
    const base = {
      db,
      queue,
      now: NOW,
      identity: { model: "test-model", protocol: "test-protocol" } as { model: string; protocol: string },
      createEngine: mk,
      workers: 1,
      batchSize: 8,
      maxFresh: 10,
    };
    const out = await judgePassages(base, "claim about cells", passages);
    assert.equal(out.interruption, null);
    assert.deepEqual([...out.scores.values()], [0.95]);
    const out2 = await judgePassages({ ...base, createEngine: mk }, "claim about cells", passages);
    assert.equal(out2.cached, 1, "clean judgments still cache");
    assert.equal(out2.fresh, 0);
  });
});

describe("cancellation: document mode stops between units", () => {
  let root: string;
  let db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-vdoccancel-"));
    db = createRegistry(root);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const BIB = "@article{x, title={T}, author={Holder, Ada}, year={2024}}";
  const setup = (): { ctx: ToolContext; key: string } => {
    const doi = "10.1111/cancel-a";
    registerPaper(
      db,
      { doi, title: "Cancel A", authors: ["Holder, Ada"], year: 2024, bibtex: BIB.replace("x,", "a,"), bibtexSource: "crossref" },
      { now: NOW },
    );
    publishSource(
      db,
      doi,
      {
        kind: "local-file",
        ref: "a.pdf",
        license: null,
        digest: "0".repeat(64),
        extraction: "t@1",
        text: "Filler paragraph about measurement methods used in the laboratory. Cells age faster at high temperature than at room temperature (markone alpha). Another filler paragraph about calibration of the instruments.",
        pageStarts: [0],
      },
      { chunk_tokens: 8192, overlap_tokens: 0, chars_per_token: 2.8, boundary: "paragraph" as const },
      NOW(),
    );
    const key = (db.prepare("SELECT citekey FROM papers WHERE doi = ?").get(doi) as { citekey: string }).citekey;
    const ctx: ToolContext = {
      root,
      fetch: (async () => {
        throw new Error("no network");
      }) as ToolContext["fetch"],
      env: { UKTUB_VERIFY_MODEL_ID: "test-model" },
      now: NOW,
      queue: new WriteQueue(),
    };
    return { ctx, key };
  };

  const manuscript = (key: string): string =>
    [
      "\\section{Background}",
      `Cells age faster at high temperature than at room temperature \\cite{${key}}.`,
      "The moon is made of green cheese.",
      "",
    ].join("\n");

  it("an aborted signal rejects before any unit starts and starts no engine work", async () => {
    const { ctx, key } = setup();
    let runs = 0;
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      documentWorkflow(
        { ...ctx, signal: controller.signal },
        db,
        { text: manuscript(key) },
        {
          fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
          createEngine: () => ({
            run: async (rows: { state: string; instructions: string }[]) => {
              runs++;
              return rows.map(() => 0.05);
            },
          }),
        },
      ),
      isCancelled,
    );
    assert.equal(runs, 0, "no document unit started engine work");
  });

  it("abort during the first unit rejects with no second unit and no wider-scope recheck work", async () => {
    const { ctx, key } = setup();
    const controller = new AbortController();
    let runs = 0;
    const text = [
      "\\section{Background}",
      `The moon is made of green cheese \\cite{${key}}.`,
      "Cells age faster at high temperature than at room temperature without any citation whatsoever here.",
      "",
    ].join("\n");
    await assert.rejects(
      documentWorkflow(
        { ...ctx, signal: controller.signal },
        db,
        { text },
        {
          fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
          createEngine: () => ({
            run: async (rows: { state: string; instructions: string }[]) => {
              runs++;
              controller.abort();
              return rows.map(() => 0.05);
            },
          }),
        },
      ),
      isCancelled,
    );
    assert.equal(runs, 1, "only the first unit started work: no second unit, no wider-scope recheck");
  });

  it("a present but un-aborted signal leaves pagination untouched", async () => {
    const { ctx, key } = setup();
    const controller = new AbortController();
    const out = await documentWorkflow(
      { ...ctx, signal: controller.signal },
      db,
      { text: manuscript(key) },
      {
        fetchImpl: (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch,
        createEngine: () => ({
          run: async (rows: { state: string; instructions: string }[]) => rows.map((r) => (r.state.includes("markone") ? 0.999 : 0.05)),
        }),
      },
    );
    assert.equal(out.kind, "ok");
    if (out.kind === "ok") {
      const units = (out.result.units as unknown[]).length;
      assert.ok(units >= 2, `expected paginated units, got ${units}`);
    }
    assert.ok(!controller.signal.aborted);
  });
});

describe("cancellation: production waits own nothing after abort", () => {
  it("a fresh process aborted during the production retry delay exits promptly (no leaked timer)", { timeout: 30000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), "uktub-vleak-"));
    try {
      const claimHref = new globalThis.URL("../src/core/verify/claim.ts", import.meta.url).href;
      const probe = join(dir, "probe.mjs");
      writeFileSync(
        probe,
        `import { fetchWith429Retry } from ${JSON.stringify(claimHref)};\n` +
          "const c = new AbortController();\n" +
          'const send = async () => new Response("limited", { status: 429, headers: { "retry-after": "5" } });\n' +
          "setTimeout(() => c.abort(), 100);\n" +
          'await fetchWith429Retry(send, { label: "probe", signal: c.signal }).then(\n' +
          '  () => console.log("unexpected-resolve"),\n' +
          "  (e) => console.log(`rejected:${e?.name ?? typeof e}`),\n" +
          ");\n",
      );
      const start = Date.now();
      const out = spawnSync(process.execPath, [probe], { encoding: "utf8", timeout: 25000 });
      const elapsed = Date.now() - start;
      assert.equal(out.status, 0, `probe stderr: ${out.stderr}`);
      assert.match(out.stdout, /rejected:CancelledError/);
      assert.ok(elapsed < 4000, `fresh process held alive ${elapsed} ms by a leaked retry timer`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("abort while reading the response body rejects and starts no second row", async () => {
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit): Promise<Response> => {
      calls++;
      const s = init?.signal;
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          if (s?.aborted === true) {
            c.error(abortErr());
            return;
          }
          s?.addEventListener("abort", () => c.error(abortErr()), { once: true });
        },
      });
      return new Response(stream, { status: 200, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const engine = systemoneEndpointEngine({ url: URL, label: "hosted", fetchImpl });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10);
    const outcome = await Promise.race([
      engine
        .run(
          [
            { state: "s1", instructions: "c1" },
            { state: "s2", instructions: "c2" },
          ],
          { signal: controller.signal },
        )
        .then(
          () => "resolved",
          (e: unknown) => e,
        ),
      new Promise((r) => setTimeout(() => r("TIMEOUT"), 2000)),
    ]);
    assert.ok(outcome instanceof Error && isCancelled(outcome), `expected a CancelledError, got ${String(outcome)}`);
    assert.equal(calls, 1, "the second row is never fetched after abort during the body");
  });
});

describe("cancellation: fully cached work still discloses the abort", () => {
  let root: string;
  let db: DatabaseSync;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "uktub-vcachedcancel-"));
    db = createRegistry(root);
  });
  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  it("abort-before-start with everything cached keeps scores and reports cancelled", async () => {
    const queue = new WriteQueue();
    const id = { model: "test-model", protocol: "test-protocol" } as { model: string; protocol: string };
    const passages = [{ text: "passage one about cells", hash: "h1" }];
    const scoring = {
      db,
      queue,
      now: NOW,
      identity: id,
      createEngine: () => ({ run: async (rows: { state: string; instructions: string }[]) => rows.map(() => 0.95) }),
      workers: 1,
      batchSize: 8,
      maxFresh: 10,
    };
    const clean = await judgePassages(scoring, "claim about cells", passages);
    assert.equal(clean.interruption, null);
    const controller = new AbortController();
    controller.abort();
    const out = await judgePassages(
      {
        ...scoring,
        createEngine: () => {
          throw new Error("no engine work may start after abort");
        },
        signal: controller.signal,
      },
      "claim about cells",
      passages,
    );
    assert.equal(out.interruption?.reason, "cancelled");
    assert.deepEqual([...out.scores.values()], [0.95], "valid cached scores are kept");
    assert.equal(out.fresh, 0);
    assert.deepEqual(out.unchecked, []);
  });
});
