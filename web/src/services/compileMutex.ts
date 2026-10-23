// SPDX-License-Identifier: AGPL-3.0-or-later
// Page-wide compile mutex (Phase 7): the agent compile, the Compile button
// (and clear-cache compile) and export share one TeX engine with no lock
// against overlapping runs, so a second request waits its turn instead of
// corrupting the in-flight run. The waiter shows "compiling" meanwhile (the
// callers set their busy state before acquiring). The mutex always releases:
// fn throwing, the timeout firing, or the agent stopping all hand the turn
// to the next waiter via `finally`.
export class CompileMutex {
	private tail: Promise<void> = Promise.resolve();

	/**
	 * Run `fn` after all earlier holders settle. When `signal` aborts while
	 * waiting, `fn` is skipped and the abort reason is thrown; an abort
	 * after `fn` started is the holder's business (it stops the engine).
	 */
	async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		const prev = this.tail;
		let release!: () => void;
		const current = new Promise<void>((resolve) => {
			release = resolve;
		});
		this.tail = current;
		try {
			if (signal?.aborted) {
				throw (
					signal.reason ??
					new DOMException('The operation was aborted', 'AbortError')
				);
			}
			if (signal) {
				await new Promise<void>((resolve, reject) => {
					const onAbort = (): void => {
						signal.removeEventListener('abort', onAbort);
						reject(
							signal.reason ??
								new DOMException('The operation was aborted', 'AbortError'),
						);
					};
					signal.addEventListener('abort', onAbort, { once: true });
					void prev.then(
						() => {
							signal.removeEventListener('abort', onAbort);
							resolve();
						},
						() => {
							// An earlier holder's failure never blocks the queue.
							signal.removeEventListener('abort', onAbort);
							resolve();
						},
					);
				});
			} else {
				try {
					await prev;
				} catch {
					// An earlier holder's failure never blocks the queue.
				}
			}
			return await fn();
		} finally {
			release();
		}
	}
}

/** The one page-wide compile turn. */
export const compileMutex = new CompileMutex();
