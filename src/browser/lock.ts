/**
 * Browser project lock over `navigator.locks`.
 *
 * The registry is one SQLite file per project on `opfs-sahpool`, where a
 * second tab's open fails loudly at the VFS layer. The lock turns that into a
 * typed refusal: `acquireProjectLock(projectId, { ifAvailable: true })`
 * returns `{ held: false, reason: "open-in-another-tab" }` when another
 * browsing context holds the project, instead of ever surfacing a lock wait
 * or a VFS error to the researcher.
 *
 * Lock name: `uktub-scholar:project:<projectId>`, exclusive. `projectId`
 * should be the canonical project path (the same string that names the
 * sahpool file), so every tab for one project contends on one name.
 */

export type ProjectLockResult =
  | { held: true; release: () => Promise<void> }
  | { held: false; reason: "open-in-another-tab" };

export interface AcquireOptions {
  /**
   * When true, never wait: report `{ held: false }` at once if another tab
   * holds the lock. When false (default), wait until the lock is free.
   */
  ifAvailable?: boolean;
}

export function lockNameForProject(projectId: string): string {
  return `uktub-scholar:project:${projectId}`;
}

interface LockManagerLike {
  request<T>(name: string, options: { mode: "exclusive"; ifAvailable?: boolean }, callback: (lock: unknown) => Promise<T>): Promise<T | undefined>;
  request<T>(name: string, callback: (lock: unknown) => Promise<T>): Promise<T>;
  query(): Promise<{ held: Array<{ name: string; mode: string }>; pending: Array<{ name: string; mode: string }> }>;
}

function locks(): LockManagerLike {
  const nav = globalThis.navigator as unknown as { locks?: LockManagerLike };
  if (!nav || !nav.locks || typeof nav.locks.request !== "function") {
    throw new Error("project lock unavailable: navigator.locks is missing (fail closed)");
  }
  return nav.locks;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Acquire the exclusive project lock and hold it until `release()` runs.
 * With `{ ifAvailable: true }` this never blocks: a held lock resolves to
 * the typed "open in another tab" refusal.
 */
export async function acquireProjectLock(
  projectId: string,
  options: AcquireOptions = {},
): Promise<ProjectLockResult> {
  if (typeof projectId !== "string" || projectId === "") {
    throw new TypeError("acquireProjectLock: projectId must be a non-empty string");
  }
  const name = lockNameForProject(projectId);
  const manager = locks();
  let release!: () => void;
  let released = false;
  const gate = new Promise<void>((resolve) => {
    release = () => { released = true; resolve(); };
  });
  const TOKEN = "uktub-project-lock-held";
  // One request holds the callback until release(). With ifAvailable the lock
  // manager invokes the callback with null when another tab holds the lock
  // (it never queues), so there is no wait and no probe-then-take race.
  const pending = manager.request(name, { mode: "exclusive", ...(options.ifAvailable ? { ifAvailable: true } : {}) }, async (lock: unknown) => {
    if (options.ifAvailable && lock === null) return null;
    await gate;
    return TOKEN;
  });
  void pending.then(
    () => {},
    () => {},
  );
  let settled = false;
  let value: unknown;
  void pending.then(
    (v) => { settled = true; value = v; },
    () => { settled = true; value = undefined; },
  );
  if (options.ifAvailable) {
    for (let i = 0; i < 40 && !settled; i++) await sleep(25);
    // Refusal settles promptly to null (callback ran with a null lock).
    if (settled && (value === null || value === undefined)) return { held: false, reason: "open-in-another-tab" };
    // Unsettled after 1 s means our callback is running: we hold the lock.
    // (A queued request with ifAvailable never waits, so pending implies held.)
  } else {
    // Blocking acquire: wait until our client holds the lock.
    for (let i = 0; i < 400; i++) {
      const state = await manager.query();
      if (state.held.some((l) => l.name === name && l.mode === "exclusive")) break;
      if (i === 399) {
        release();
        await pending;
        throw new Error("project lock acquisition timed out (fail closed)");
      }
      await sleep(25);
    }
  }
  let done = false;
  return {
    held: true,
    release: async () => {
      if (done) return;
      done = true;
      if (!released) release();
      await pending;
    },
  };
}
