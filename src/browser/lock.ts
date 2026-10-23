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
  request(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean; signal?: AbortSignal },
    callback: (lock: unknown) => Promise<unknown>,
  ): Promise<unknown>;
}

function locks(): LockManagerLike {
  const nav = globalThis.navigator as unknown as { locks?: LockManagerLike };
  if (!nav || !nav.locks || typeof nav.locks.request !== "function") {
    throw new Error("project lock unavailable: navigator.locks is missing (fail closed)");
  }
  return nav.locks;
}

/**
 * Acquire the exclusive project lock and hold it until `release()` runs.
 * With `{ ifAvailable: true }` this never blocks: a held lock resolves to
 * the typed "open in another tab" refusal. The outcome comes from the lock
 * manager's callback (a `null` lock is the refusal), never from timing.
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
  let openGate!: () => void;
  const gate = new Promise<void>((resolve) => { openGate = resolve; });
  let settle!: (result: ProjectLockResult | null) => void;
  let fail!: (error: unknown) => void;
  const outcome = new Promise<ProjectLockResult | null>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  // Blocking mode is bounded by client policy: a request not granted within
  // 10 s is dropped by the lock manager (fail closed).
  const request = options.ifAvailable
    ? { mode: "exclusive" as const, ifAvailable: true }
    : { mode: "exclusive" as const, signal: AbortSignal.timeout(10_000) };
  const TOKEN = "uktub-project-lock-held";
  // One request holds the callback until release(). With ifAvailable the lock
  // manager invokes the callback with null when another context holds the
  // lock (it never queues), so the refusal is decided right here.
  const pending = manager.request(name, request, async (lock: unknown) => {
    if (lock === null) {
      settle(null);
      return TOKEN;
    }
    let done = false;
    settle({
      held: true,
      release: async () => {
        if (done) return;
        done = true;
        openGate();
        await pending;
      },
    });
    await gate;
    return TOKEN;
  });
  // Rejects only when the blocking request is aborted before it is granted.
  pending.catch(fail);
  let result: ProjectLockResult | null;
  try {
    result = await outcome;
  } catch {
    throw new Error("project lock acquisition timed out (fail closed)");
  }
  if (result === null) return { held: false, reason: "open-in-another-tab" };
  return result;
}
