/**
 * In-process FIFO write queue (KTD5, R15 in-process half). Pi documents no
 * sequential mode for model-issued tool calls, so overlapping tool calls that
 * write the registry serialize their TRANSACTIONAL sections here; provider
 * fetches stay outside the queue (they hold no registry state).
 *
 * Host-agnostic: no Pi, no globals. The Pi adapter holds one instance and
 * feeds each registry/compile write section through `runExclusive`.
 *
 * FIFO is call-arrival order: each `runExclusive` chains onto the tail of the
 * promise chain at call time, so section N+1 cannot interleave with section N.
 * The callback's returned value (sync or a settled promise) resolves in the
 * same order the calls arrived.
 */

export class WriteQueue {
  private tail: Promise<unknown> = Promise.resolve();

  /**
   * Run `fn` as one exclusive section: no other section's synchronous body —
   * or the awaited critical part it returns — runs between this section's
   * start and end. Errors do not break the chain: the next section runs, the
   * rejection surfaces to this call's own awaiter.
   */
  runExclusive<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn) as Promise<T>;
    // Keep the tail a fulfilled promise so one failure never poisons later
    // sections; callers still receive `run`'s own rejection.
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
}
