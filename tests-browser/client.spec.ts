/**
 * Tests for UktubBrowserClient (`src/browser/client.ts`):
 * 1. Unit tests with mock Worker verifying correlation IDs, timeouts, boot gate,
 *    cancellation, and worker crash rejection.
 * 2. Integration tests in Chromium executing the real bundled worker.js through
 *    UktubBrowserClient (init, tool calls, file-store operations, export/import).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { bundle } from "./build.mjs";
import { serveDirectory } from "./server.mjs";
import { launchChromium } from "./launch.mjs";
import { tmpDir } from "./tmp.mjs";
import { FIXED_NOW_ISO, TEST_PROVIDER_CONFIG } from "./scenarios/tools.ts";

class MockWorker extends EventTarget {
  public posted: unknown[] = [];
  public terminated = false;

  public postMessage(msg: unknown): void {
    this.posted.push(msg);
  }

  public terminate(): void {
    this.terminated = true;
  }

  public emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  public emitError(err: Error): void {
    this.dispatchEvent(new ErrorEvent("error", { message: err.message, error: err }));
  }
}

/** Resolves with `label` after `ms`, so a promise race turns a hang into a fast failure. */
function sentinel(label: string, ms: number): Promise<string> {
  return new Promise((resolve) => setTimeout(() => resolve(label), ms));
}

test("UktubBrowserClient: unit mock worker protocol, timeouts, cancellation", async () => {
  // Dynamically import client (will fail before client.ts is created)
  const { UktubBrowserClient, createUktubClient } = await import("../src/browser/client.ts");

  // 1. Boot failure rejection
  {
    const mock = new MockWorker();
    const client = new UktubBrowserClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: false, error: "SQLite WASM init error" });
    await assert.rejects(() => client.ready, /boot failed: SQLite WASM init error/i);
    client.terminate();
  }

  // 2. Successful boot gate + request/response correlation
  {
    const mock = new MockWorker();
    const client = createUktubClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const reqPromise = client.init({ projectId: "mock-proj" });
    assert.equal(mock.posted.length, 1);
    const req = mock.posted[0] as { id: string; op: string; args: Record<string, unknown> };
    assert.equal(req.op, "init");
    assert.equal(req.args.projectId, "mock-proj");

    mock.emitMessage({ id: req.id, ok: true, result: { ok: true } });
    const res = await reqPromise;
    assert.deepEqual(res, { ok: true });
    client.terminate();
  }

  // 3. Request timeout
  {
    const mock = new MockWorker();
    const client = new UktubBrowserClient(mock as unknown as Worker, { timeoutMs: 50 });
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    await assert.rejects(
      () => client.request("slowOp", {}, { timeoutMs: 30 }),
      /request "slowOp" timed out after 30ms/i,
    );
    client.terminate();
  }

  // 4. AbortSignal cancellation
  {
    const mock = new MockWorker();
    const client = new UktubBrowserClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const ac = new AbortController();
    const callPromise = client.callTool("verify", { claim: "test" }, { signal: ac.signal });
    assert.equal(mock.posted.length, 1);
    const req = mock.posted[0] as { id: string; op: string; args: Record<string, unknown> };
    assert.equal(req.op, "callTool");

    // Abort triggers cancellation message
    ac.abort();
    await assert.rejects(() => callPromise, (err: unknown) => {
      return err instanceof DOMException && err.name === "AbortError";
    });

    // Check that cancelTool was posted
    const cancelMsg = mock.posted.find((m: any) => m.op === "cancelTool") as any;
    assert.ok(cancelMsg !== undefined);
    assert.equal(cancelMsg.args.callId, req.args.callId);
    client.terminate();
  }

  // 5. Worker crash / termination
  {
    const mock = new MockWorker();
    const client = new UktubBrowserClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const pending = client.listFiles();
    mock.emitError(new Error("Out of memory in WebWorker"));
    await assert.rejects(() => pending, /Worker crash: Out of memory/i);
    client.terminate();
  }

  // 6. Pre-aborted signal rejects immediately without posting to worker
  {
    const mock = new MockWorker();
    const client = createUktubClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const ac = new AbortController();
    ac.abort();

    await assert.rejects(
      () => client.request("op", {}, { signal: ac.signal }),
      (err: any) => err.name === "AbortError",
    );
    assert.equal(mock.posted.length, 0, "No message should be sent to worker");
    client.terminate();
  }

  // 7. High concurrency (50 requests resolved in reverse order)
  {
    const mock = new MockWorker();
    const client = createUktubClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const count = 50;
    const requests = Array.from({ length: count }, (_, i) => client.request("ping", { i }));
    assert.equal(mock.posted.length, count);

    // Resolve in reverse order
    const posted = mock.posted as { id: string }[];
    for (let i = posted.length - 1; i >= 0; i--) {
      mock.emitMessage({ id: posted[i].id, ok: true, result: `pong-${i}` });
    }

    const results = await Promise.all(requests);
    assert.equal(results.length, count);
    for (let i = 0; i < count; i++) {
      assert.equal(results[i], `pong-${i}`);
    }
    client.terminate();
  }

  // 8. Close race condition
  {
    const mock = new MockWorker();
    const client = createUktubClient(mock as unknown as Worker);
    mock.emitMessage({ boot: true, ok: true });
    await client.ready;

    const closePromise = client.close();
    // Subsequent request must fail immediately because client is closing
    await assert.rejects(
      () => client.request("op"),
      /UktubBrowserClient is closed/i,
    );

    // Complete the close operation
    const closeMsg = mock.posted.find((m: any) => m.op === "close") as any;
    assert.ok(closeMsg !== undefined);
    mock.emitMessage({ id: closeMsg.id, ok: true, result: { ok: true } });
    await closePromise;
    client.terminate();
  }

  // 9. Crash during boot rejects client.ready
  {
    const mock = new MockWorker();
    const client = new UktubBrowserClient(mock as unknown as Worker);

    mock.emitError(new Error("Boot crash"));
    await assert.rejects(
      () => client.ready,
      /UktubBrowserClient boot error: Boot crash/i,
    );
    client.terminate();
  }
});

test("UktubBrowserClient: terminate before boot rejects parked requests and removes boot listeners", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const removed: string[] = [];
  const removeListener = mock.removeEventListener.bind(mock);
  mock.removeEventListener = (type: string, listener: EventListenerOrEventListenerObject | null, options?: EventListenerOptions | boolean) => {
    removed.push(type);
    removeListener(type, listener, options);
  };

  const client = new UktubBrowserClient(mock as unknown as Worker);
  const parked = client.request("op");
  client.terminate();

  const outcome = await Promise.race([
    parked.then(() => "resolved", (err: Error) => err.message),
    sentinel("request still pending after terminate", 500),
  ]);
  assert.match(outcome, /worker terminated/i);
  assert.ok(removed.includes("message") && removed.includes("error"), `boot listeners removed; saw: ${removed.join(",")}`);
});

test("UktubBrowserClient: callTool timeout posts cancelTool for its callId", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const client = new UktubBrowserClient(mock as unknown as Worker);
  mock.emitMessage({ boot: true, ok: true });
  await client.ready;

  await assert.rejects(
    () => client.callTool("verify", { claim: "wedged" }, { callId: "call-wedged", timeoutMs: 20 }),
    /timed out after 20ms/i,
  );
  const cancelMsg = mock.posted.find((m: any) => m.op === "cancelTool") as any;
  assert.ok(cancelMsg !== undefined, "timed-out callTool must post cancelTool");
  assert.equal(cancelMsg.args.callId, "call-wedged");
  client.terminate();
});

test("UktubBrowserClient: late reply to a timed-out call cannot resolve a reused callId", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const client = new UktubBrowserClient(mock as unknown as Worker);
  mock.emitMessage({ boot: true, ok: true });
  await client.ready;

  await assert.rejects(
    () => client.callTool("verify", {}, { callId: "reused", timeoutMs: 20 }),
    /timed out after 20ms/i,
  );
  const first = mock.posted.find((m: any) => m.op === "callTool") as { id: string };

  const second = client.callTool("verify", { n: 2 }, { callId: "reused", timeoutMs: 1000 });
  const secondReq = mock.posted.filter((m: any) => m.op === "callTool")[1] as { id: string; args: { callId: string } };
  assert.equal(secondReq.args.callId, "reused");
  assert.notEqual(secondReq.id, first.id, "each posted message needs its own correlation id");

  // The first call's reply arrives late and must not settle the second call.
  mock.emitMessage({ id: first.id, ok: true, result: "STALE" });
  const outcome = await Promise.race([
    second.then((v) => `resolved:${v}`, (err: Error) => `rejected:${err.message}`),
    sentinel("second call still pending", 100),
  ]);
  assert.equal(outcome, "second call still pending");

  mock.emitMessage({ id: secondReq.id, ok: true, result: "FRESH" });
  assert.equal(await second, "FRESH");
  client.terminate();
});

test("UktubBrowserClient: concurrent close() calls share one close operation", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const client = new UktubBrowserClient(mock as unknown as Worker);
  mock.emitMessage({ boot: true, ok: true });
  await client.ready;

  const first = client.close();
  const second = client.close();
  const closeMsgs = mock.posted.filter((m: any) => m.op === "close") as { id: string }[];
  assert.equal(closeMsgs.length, 1, "only one close op should reach the worker");

  mock.emitMessage({ id: closeMsgs[0].id, ok: true, result: { ok: true } });
  assert.deepEqual(await Promise.all([first, second]), [{ ok: true }, { ok: true }]);
  client.terminate();
});

test("UktubBrowserClient: post-boot worker crash is fatal, later requests fail fast and the worker is terminated", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const client = new UktubBrowserClient(mock as unknown as Worker, { timeoutMs: 5000 });
  mock.emitMessage({ boot: true, ok: true });
  await client.ready;

  const pending = client.listFiles();
  mock.emitError(new Error("Out of memory in WebWorker"));
  await assert.rejects(() => pending, /Worker crash: Out of memory/i);

  // A request made after the crash must fail at once, not wait for its 5,000ms timeout.
  const later = client.request("op");
  const outcome = await Promise.race([
    later.then(() => "resolved", (err: Error) => err.message),
    sentinel("request still pending", 200),
  ]);
  assert.match(outcome, /crash/i);
  assert.match(outcome, /Out of memory/i);
  assert.equal(mock.terminated, true, "a post-boot crash must terminate the worker");
  assert.equal(mock.posted.filter((m: any) => m.op === "op").length, 0, "nothing is posted after a crash");
  client.terminate();
});

test("UktubBrowserClient: close() after a post-boot worker crash settles promptly", async () => {
  const { UktubBrowserClient } = await import("../src/browser/client.ts");
  const mock = new MockWorker();
  const client = new UktubBrowserClient(mock as unknown as Worker, { timeoutMs: 5000 });
  mock.emitMessage({ boot: true, ok: true });
  await client.ready;

  mock.emitError(new Error("Out of memory in WebWorker"));
  const outcome = await Promise.race([
    client.close().then((res) => JSON.stringify(res), (err: Error) => `rejected:${err.message}`),
    sentinel("close still pending", 50),
  ]);
  assert.notEqual(outcome, "close still pending");
  assert.equal(mock.posted.filter((m: any) => m.op === "close").length, 0, "a crashed worker gets no close op");
  client.terminate();
});

test("UktubBrowserClient: real Chromium worker integration",{ timeout: 120000 }, async () => {
  const root = path.resolve(import.meta.dirname, "..");
  const outdir = tmpDir("diff-client-www-");

  // Bundle the client bundle for in-page execution
  await bundle("tests-browser/client-page.ts", path.join(path.relative(root, outdir), "client-page.js"));
  await bundle("src/browser/worker.ts", path.join(path.relative(root, outdir), "worker.js"));
  fs.copyFileSync(path.join(root, "tests-browser/page.html"), path.join(outdir, "page.html"));

  const server = await serveDirectory(outdir);
  const { browser } = await launchChromium();
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${server.url}/page.html`, { waitUntil: "load" });
    await page.addScriptTag({ url: `${server.url}/client-page.js` });

    // Run client tests in browser page
    const outcome = (await page.evaluate(async ({ workerUrl, nowIso, routes, providerConfig }) => {
      const runFn = (window as any).__runClientTest;
      if (typeof runFn !== "function") throw new Error("client-page.js did not export __runClientTest");
      return await runFn({ workerUrl, nowIso, routes, providerConfig });
    }, {
      workerUrl: `${server.url}/worker.js`,
      nowIso: FIXED_NOW_ISO,
      routes: [],
      providerConfig: TEST_PROVIDER_CONFIG,
    })) as { ok: boolean; checks: Record<string, boolean> };

    assert.equal(outcome.ok, true, `browser client integration failed: ${JSON.stringify(outcome)}`);
    assert.equal(outcome.checks.boot, true);
    assert.equal(outcome.checks.init, true);
    assert.equal(outcome.checks.writeFile, true);
    assert.equal(outcome.checks.readFile, true);
    assert.equal(outcome.checks.deleteFile, true);
    assert.equal(outcome.checks.listFiles, true);
    assert.equal(outcome.checks.preAborted, true);
    assert.equal(outcome.checks.doctorTool, true);
    assert.equal(outcome.checks.exportProject, true);
    assert.equal(outcome.checks.importProject, true);
    assert.equal(outcome.checks.closedRejection, true);
  } finally {
    await browser.close();
    await server.close();
  }
});
