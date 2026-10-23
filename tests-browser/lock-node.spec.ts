/** Node-level project-lock tests over the real or a fake `navigator.locks`. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { acquireProjectLock, lockNameForProject } from "../src/browser/lock.ts";

type Locks = Record<string, unknown>;

// Replace `navigator.locks` for one body; the own property shadows the Node getter and is deleted afterwards.
async function withLocks<T>(fake: unknown, body: () => Promise<T>): Promise<T> {
  const nav = globalThis.navigator as unknown as Locks;
  Object.defineProperty(nav, "locks", { value: fake, configurable: true });
  try {
    return await body();
  } finally {
    delete nav.locks;
  }
}

test("uncontended ifAvailable acquire resolves held without waiting", async () => {
  const id = `node-uncontended-${Date.now().toString(36)}`;
  const started = performance.now();
  const result = await acquireProjectLock(id, { ifAvailable: true });
  const elapsed = performance.now() - started;
  assert.equal(result.held, true);
  assert.ok(elapsed < 300, `acquire took ${elapsed.toFixed(0)} ms; expected < 300 ms`);
  if (result.held) await result.release();
});

test("ifAvailable refusal whose null callback arrives late is still a refusal", async () => {
  // Fake manager: the lock is busy, and the null callback arrives after 1.2 s.
  const fake = {
    request(_name: string, _options: unknown, callback: (lock: unknown) => Promise<unknown>) {
      return new Promise((resolve) => setTimeout(() => resolve(callback(null)), 1200));
    },
  };
  const result = await withLocks(fake, () => acquireProjectLock("node-late-refusal", { ifAvailable: true }));
  assert.deepEqual(result, { held: false, reason: "open-in-another-tab" });
});

test("blocking acquire does not report held while another holder owns the lock", async () => {
  const id = `node-blocking-${Date.now().toString(36)}`;
  const name = lockNameForProject(id);
  const manager = (globalThis.navigator as unknown as { locks: { request: Function } }).locks;
  let markGranted!: () => void;
  const granted = new Promise<void>((resolve) => { markGranted = resolve; });
  let releaseHolder!: () => void;
  const holderGate = new Promise<void>((resolve) => { releaseHolder = resolve; });
  const holder = manager.request(name, { mode: "exclusive" }, async () => {
    markGranted();
    await holderGate;
  }) as Promise<void>;
  try {
    await granted;
    let settled = false;
    const acquire = acquireProjectLock(id).then((r) => { settled = true; return r; });
    acquire.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(settled, false, "blocking acquire reported held while the holder still owns the lock");
    releaseHolder();
    await holder;
    const result = await acquire;
    assert.equal(result.held, true);
    if (result.held) await result.release();
  } finally {
    releaseHolder();
    await holder;
  }
});
