// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser auto-retry for the agent (Phase 9d): the same predicate and the
// same default policy as Node Pi, applied to the parent agent and the
// `write_section` child.
//
// Pi reference (exact pins in `web/package.json`):
// - predicate: `isRetryableAssistantError` from `@earendil-works/pi-ai`
//   (`dist/utils/retry.js`: 429/rate-limit/5xx/transient; quota and
//   context-overflow shapes are NOT retryable).
// - policy: `SETTINGS_DEFAULTS.retry` in
//   `@earendil-works/pi-coding-agent` 1.3.0
//   (`dist/core/settings-defaults.js`): enabled, maxRetries 3,
//   baseDelayMs 2000, maxAgentDelayMs 60_000; per-attempt delay
//   `retryDelayMs(policy, attempt)` (exponential, capped).
// - loop: `_prepareRetry` in `dist/core/agent-session.js` (auto_retry_start
//   event, omit the failed attempt from the model projection, abortable
//   backoff sleep; aborts during the sleep settle as an aborted turn).
//
// pi-agent-core runs no retry of its own (an error assistant message ends
// the turn at once: `agent-loop.js` returns on `stopReason === "error"`),
// so this wrapper sits in the `StreamFn`: failed attempts never reach the
// loop (their events are dropped, the partial is cut from the context —
// Pi's `_omitRecoveryAttempt`), and only one terminal event plus one final
// message per attempt-batch is ever emitted.
import type { StreamFn } from '@earendil-works/pi-agent-core';
import {
	createAssistantMessageEventStream,
	isRetryableAssistantError,
	retryDelayMs,
} from '@earendil-works/pi-ai';
import type { AssistantMessage } from '@earendil-works/pi-ai';

/** Pi `SETTINGS_DEFAULTS.retry` (agent-level slice), mirrored by value. */
export const AGENT_RETRY_POLICY = {
	enabled: true,
	maxRetries: 3,
	baseDelayMs: 2000,
	maxAgentDelayMs: 60_000,
};

export interface AgentRetryInfo {
	attempt: number;
	maxAttempts: number;
	delayMs: number;
	errorMessage: string;
}

export interface AgentRetryHooks {
	policy?: Partial<typeof AGENT_RETRY_POLICY>;
	onRetry?: (info: AgentRetryInfo) => void | Promise<void>;
	/** Counts performed retries (the `write_section` child tally reads this). */
	count?: { count: number };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(signal.reason ?? new Error('Aborted'));
			return;
		}
		const timer = setTimeout(() => {
			signal?.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = (): void => {
			clearTimeout(timer);
			reject(signal?.reason ?? new Error('Aborted'));
		};
		signal?.addEventListener('abort', onAbort, { once: true });
	});
}

/**
 * Wrap a `StreamFn` with the Pi retry loop. Failed attempts are omitted
 * (their events never reach the loop, their partial never reaches the
 * model); the backoff wait aborts with the run signal, settling the turn
 * as aborted at once with no further request.
 */
export function withAgentRetry(inner: StreamFn, hooks?: AgentRetryHooks): StreamFn {
	const policy = { ...AGENT_RETRY_POLICY, ...hooks?.policy };
	const streamFn = (async (
		model: Parameters<StreamFn>[0],
		context: Parameters<StreamFn>[1],
		options?: Parameters<StreamFn>[2],
	) => {
		const signal = options?.signal;
		const out = createAssistantMessageEventStream();
		const startLen = context.messages.length;
		let final: AssistantMessage | null = null;
		let attempt = 0;
		const run = (async (): Promise<void> => {
			for (;;) {
				const stream = await inner(model, context, options);
				let terminal: Parameters<typeof out.push>[0] | null = null;
				for await (const event of stream) {
					if (event.type === 'done' || event.type === 'error') {
						terminal = event;
						break;
					}
					out.push(event);
				}
				const message = await stream.result();
				const retryable =
					message.stopReason === 'error' &&
					!signal?.aborted &&
					policy.enabled &&
					attempt < policy.maxRetries &&
					isRetryableAssistantError(message);
				if (!retryable) {
					final = message;
					if (terminal) out.push(terminal);
					return;
				}
				// Omit the failed attempt: the loop never sees its events and
				// the model never sees its partial (Pi `_omitRecoveryAttempt`).
				context.messages.length = startLen;
				attempt++;
				if (hooks?.count) hooks.count.count = attempt;
				const delayMs = retryDelayMs(policy, attempt);
				const errorMessage = message.errorMessage || 'Unknown error';
				try {
					await hooks?.onRetry?.({ attempt, maxAttempts: policy.maxRetries, delayMs, errorMessage });
				} catch {
					// A reporting hook must never break the retry itself.
				}
				try {
					await sleep(delayMs, signal);
				} catch {
					// Stop during the wait: settle as an aborted turn at once.
					const { errorMessage: _dropped, ...rest } = message;
					final = { ...rest, stopReason: 'aborted' } as AssistantMessage;
					return;
				}
			}
		})();
		void run.then(
			() => {
				if (final) out.end(final);
			},
			(error: unknown) => {
				// The StreamFn contract says the inner function never throws;
				// a throw here is unexpected, so surface it and end the turn.
				const message = {
					role: 'assistant',
					content: [],
					stopReason: 'error',
					errorMessage: error instanceof Error ? error.message : String(error),
				} as unknown as AssistantMessage;
				final = message;
				out.end(message);
			},
		);
		return out;
	}) as StreamFn;
	return streamFn;
}
