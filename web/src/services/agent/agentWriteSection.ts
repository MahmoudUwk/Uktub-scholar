// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser `write_section` (Phase 8b): the shared definition from the repo
// root (`src/agent/`, no copy) with a pi-agent-core child session.
//
// Pi parity (see `src/pi/index.ts` `makeSectionWriterTool`):
// - Same tool identity (name/label/description/parameters), same
//   `prepareArguments` coercion and validation, same forward schemas with
//   `normalizeForwardPapers`, same `runWriteSection` lifecycle (one repair
//   round, never writes files), same result text via
//   `composeSectionResultText`, same refusal/malformed mapping.
// - Child runs on the parent's current model and key with only the
//   `passages` and `verify` forwards; the parent's abort signal cancels the
//   child and any in-flight worker call.
// - The gate never acts on the child: it only ever sees the parent's
//   events (the child has no gate wiring; its events feed only the tally).
//
// Differences from Pi (recorded in `web/FORK.md`):
// - The child system prompt is the shared surface composition
//   (`rules + workflow`); Pi's child additionally gets Pi's coding-agent
//   default prompt sections and our extension's `before_agent_start` rules.
// - `disposeWriter` detaches the tally subscription (pi-agent-core has no
//   session dispose); usage `cost.total` comes from pi-ai's catalog pricing.
// - Phase 9d D3: pi-agent-core runs no auto-retry of its own, so the child
//   stream is wrapped with the same Pi retry loop as the parent; performed
//   retries land in `details.child.retries` next to the tally.
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import {
	composeSectionResultText,
	coerceSectionArgs,
	ForwardPassagesParams,
	ForwardVerifyParams,
	lastAssistantText,
	normalizeForwardPapers,
	toSectionParams,
	verifyRefusalText,
	VERIFY_MALFORMED_TEXT,
	WRITE_SECTION_DESCRIPTION,
	WRITE_SECTION_LABEL,
	WRITE_SECTION_NAME,
	WriteSectionParams,
} from '@uktub-root/src/agent/section-tool.ts';
import { createChildTally, runWriteSection } from '@uktub-root/src/agent/section-writer.ts';
import { withAgentRetry, type AgentRetryInfo } from './agentRetry';
import { deriveChildSessionId, formatChildUsageLine } from './agentSession';
import type { ChildUsageTotals } from './agentSession';

import type { CoreToolResult, PanelToolResult } from './agentUktubTools';

export type WriteSectionStreamFn = ConstructorParameters<typeof Agent>[0]['streamFn'];

export interface WriteSectionToolDeps {
	/** The parent's current model at call time (the picker applies to the next prompt). */
	getModel: () => unknown;
	/** Same key lookup the parent uses. */
	getApiKey: (provider: string) => string | undefined | Promise<string | undefined>;
	streamFn: WriteSectionStreamFn;
	/** Shared surface composition (rules, then the workflow) — the closest browser equivalent of the Pi child prompt. */
	systemPrompt: string;
	/** Worker `callTool` (passages / verify forwards and document verification). */
	callWorkerTool: (
		name: string,
		args: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	) => Promise<CoreToolResult>;
	/** Test/diagnostics seam: observes the child right after creation. */
	onChild?: (child: Agent) => void;
	/**
	 * Phase 9d D3: observes each child auto-retry (the panel shows a
	 * visible transcript row; never throws).
	 */
	onChildRetry?: (info: AgentRetryInfo) => void | Promise<void>;
	/**
	 * Phase 9i: the parent's stable session id. The child gets a derived
	 * id per invocation (own sticky-routing slot); absent in tests or
	 * callers without a parent conversation.
	 */
	getSessionId?: () => string | undefined;
}

/**
 * Browser-transport budgets (the Pi host has no RPC hop): free-tier
 * verification judgments arrive over many slow HTTP round trips, so the
 * document check and the child forwards get longer than the client's
 * 60 s default. The parent abort signal still cancels any of them.
 */
export const WRITE_SECTION_FORWARD_TIMEOUT_MS = 300_000;
export const WRITE_SECTION_VERIFY_TIMEOUT_MS = 600_000;

/** Join a worker result to the model-facing text (the worker shape is known; refusals stay plain text, as in Pi). */
function workerText(result: CoreToolResult): string {
	return result.content
		.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text)
		.join('\n');
}

function refusedOf(result: CoreToolResult): { code?: unknown; message?: unknown } | undefined {
	return (result.details as { refused?: { code?: unknown; message?: unknown } }).refused;
}

function errorResult(text: string, details: unknown): PanelToolResult {
	return { content: [{ type: 'text', text }], details, isError: true };
}

/**
 * One-line child activity summary for the `write_section` tool row
 * (turns, tool calls, words, first-draft/final supported counts); numbers
 * only, bounded. Empty when the result carries no child stats.
 */
export function writeSectionChildSummary(result: unknown): string {
	const details = (result as { details?: unknown } | null)?.details as
		| {
				child?: { turns?: unknown; toolCalls?: unknown; usage?: unknown };
				words?: unknown;
				firstDraft?: { ok?: unknown; units?: unknown };
				final?: { ok?: unknown; units?: unknown };
		  }
		| undefined;
	if (!details || typeof details !== 'object') return '';
	const turns = details.child?.turns;
	const toolCalls = details.child?.toolCalls;
	const words = details.words;
	const first = details.firstDraft;
	const final = details.final;
	const base =
		typeof turns === 'number' &&
		typeof toolCalls === 'number' &&
		typeof words === 'number' &&
		typeof first?.ok === 'number' &&
		typeof first?.units === 'number' &&
		typeof final?.ok === 'number' &&
		typeof final?.units === 'number'
			? `child: ${turns} turns, ${toolCalls} tool calls, ${words} words; first draft ${first.ok}/${first.units} supported; final ${final.ok}/${final.units}`
			: '';
	// Phase 9i: the child's token usage rides the same row (the tally in
	// root `src/agent/` already collects it per child run).
	const raw = details.child?.usage as
		| { input?: unknown; output?: unknown; cacheRead?: unknown; cacheWrite?: unknown; costUsd?: unknown }
		| undefined;
	const usageLine =
		raw !== undefined && (typeof raw === 'object' || typeof raw === 'function')
			? formatChildUsageLine({
					input: raw.input,
					output: raw.output,
					cacheRead: raw.cacheRead,
					cacheWrite: raw.cacheWrite,
					costUsd: raw.costUsd,
				} as ChildUsageTotals)
			: '';
	return [base, usageLine].filter((s) => s !== '').join('\n');
}

export function buildWriteSectionTool(deps: WriteSectionToolDeps): AgentTool {
	// Phase 9i: per-invocation child sequence; the child id is stable for
	// the whole run and distinct across runs.
	let childSeq = 0;
	const tool = {
		name: WRITE_SECTION_NAME,
		label: WRITE_SECTION_LABEL,
		description: WRITE_SECTION_DESCRIPTION,
		parameters: WriteSectionParams as unknown as AgentTool['parameters'],
		prepareArguments: (args: unknown) => coerceSectionArgs(args) as never,
		execute: async (_toolCallId: string, params: unknown, signal?: AbortSignal): Promise<PanelToolResult> => {
			let section;
			try {
				section = toSectionParams((params ?? {}) as Record<string, unknown>);
			} catch (err) {
				return { content: [{ type: 'text', text: `write_section refused: ${err instanceof Error ? err.message : String(err)}` }], details: {} };
			}
			// Already cancelled: never create the child.
			signal?.throwIfAborted();
			const forward = (
				kind: 'passages' | 'verify',
				description: string,
				parameters: unknown,
			): AgentTool => ({
				name: kind,
				label: kind === 'verify' ? 'Verify claim' : 'Search passages',
				description,
				parameters: parameters as AgentTool['parameters'],
				execute: async (_id: string, p: unknown, nestedSignal?: AbortSignal) => {
					// Both signals stay live: the parent's cancellation must never be
					// masked by the nested call's own signal.
					const combined =
						nestedSignal !== undefined && signal !== undefined
							? AbortSignal.any([signal, nestedSignal])
							: (nestedSignal ?? signal);
					try {
						const result = await deps.callWorkerTool(
							kind,
							normalizeForwardPapers(p) as Record<string, unknown>,
							combined !== undefined
								? { signal: combined, timeoutMs: WRITE_SECTION_FORWARD_TIMEOUT_MS }
								: { timeoutMs: WRITE_SECTION_FORWARD_TIMEOUT_MS },
						);
						return { content: [{ type: 'text', text: workerText(result) }], details: {} };
					} catch (err) {
						if (combined?.aborted || (err instanceof Error && /abort/i.test(err.message))) throw err;
						const message = err instanceof Error ? err.message : String(err);
						return {
							content: [{ type: 'text', text: `tool ${kind} failed: ${message}` }],
							details: { thrown: true, tool: kind, message },
							isError: true,
						};
					}
				},
			}) as AgentTool;
			const startedMs = Date.now();
			// Phase 9d D3: the child retries with the same Pi policy as the
			// parent (pi-agent-core emits no retry of its own). The wrapper
			// counts each performed retry; it lands in `details.child.retries`
			// below, next to the tally the shared `createChildTally` keeps.
			const childRetries = { count: 0 };
			// Phase 9i: the child pins its own sticky-routing slot for its
			// multi-turn run (its static prefix differs from the parent's).
			const parentSessionId = deps.getSessionId?.();
			const childSessionId =
				parentSessionId === undefined ? undefined : deriveChildSessionId(parentSessionId, ++childSeq);
			const child = new Agent({
				initialState: {
					systemPrompt: deps.systemPrompt,
					model: deps.getModel() as never,
					thinkingLevel: 'off',
					tools: [
						forward('passages', 'Search the registered papers for passages about a query.', ForwardPassagesParams),
						forward('verify', 'Check one claim against the registered papers.', ForwardVerifyParams),
					],
					messages: [],
				},
				streamFn: withAgentRetry(deps.streamFn, {
					count: childRetries,
					onRetry: (info) => deps.onChildRetry?.(info),
				}),
				// Phase 9i: stable id for the whole child run (undefined
				// without a parent conversation; pi-agent-core forwards it
				// to every stream call).
				sessionId: childSessionId,
				getApiKey: deps.getApiKey,
			});
			deps.onChild?.(child);
			// Abort after creation but before the run: the owner still settles it.
			signal?.throwIfAborted();
			// Child-session totals come from its own events (never from its text).
			const tally = createChildTally(startedMs);
			const detach = child.subscribe((event) => tally.record(event));
			try {
				const out = await runWriteSection(
					{
						runWriter: async (prompt: string) => {
							// Only this prompt's messages may supply section text: capture the
							// index first so a failed/empty turn can never return earlier text.
							const startIndex = child.state.messages.length;
							await child.prompt(prompt);
							const text = lastAssistantText(child.state, startIndex);
							if (text === '') throw new Error('the writer sub-session returned no text');
							return text;
						},
						verifyDocument: async (text: string, offset: number) => {
							const result = await deps.callWorkerTool(
								'verify',
								{ text, offset },
								{ timeoutMs: WRITE_SECTION_VERIFY_TIMEOUT_MS, ...(signal !== undefined ? { signal } : {}) },
							);
							const refused = refusedOf(result);
							if (refused !== undefined) throw new Error(verifyRefusalText(refused));
							const sc = result.structuredContent as {
								units: unknown;
								summary?: { total?: unknown };
								next?: unknown;
							} | null | undefined;
							if (
								sc == null ||
								!Array.isArray(sc.units) ||
								typeof sc.summary?.total !== 'number' ||
								sc.next === undefined
							) {
								throw new Error(VERIFY_MALFORMED_TEXT);
							}
							return {
								units: sc.units,
								summary: sc.summary,
								next: sc.next,
							} as never;
						},
						abortWriter: async () => {
							child.abort();
						},
						disposeWriter: () => {
							detach();
						},
					},
					{
						goal: section.goal,
						papers: section.papers,
						...(section.query !== undefined ? { query: section.query } : {}),
						...(section.maxWords !== undefined ? { maxWords: section.maxWords } : {}),
					},
					signal,
				);
				return {
					content: [{ type: 'text', text: composeSectionResultText(out) }],
					details: {
						child: { ...tally.stats(Date.now()), retries: tally.stats(Date.now()).retries + childRetries.count },
						firstDraft: out.firstDraft,
						final: out.final,
						repaired: out.repaired,
						words: out.words,
					},
				};
			} catch (err) {
				if (signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) throw err;
				const message = err instanceof Error ? err.message : String(err);
				return errorResult(message, {
					child: { ...tally.stats(Date.now()), retries: tally.stats(Date.now()).retries + childRetries.count },
				});
			} finally {
				detach();
			}
		},
	};
	return tool as unknown as AgentTool;
}
