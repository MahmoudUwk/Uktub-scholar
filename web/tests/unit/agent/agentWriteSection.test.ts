// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 8b Part B (TDD-first): the browser `write_section` tool against the
// REAL pi-agent-core loop with the pi-ai faux provider (no network).
//
// The worker client below stands in for `UktubBrowserClient.callTool` (its
// real result shapes are pinned by `tests-browser/verify-engine.spec.ts`);
// every assertion here is on observable tool behavior, never on mock calls
// or source text.
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import {
	buildWriteSectionTool,
	writeSectionChildSummary,
	WRITE_SECTION_FORWARD_TIMEOUT_MS,
	WRITE_SECTION_VERIFY_TIMEOUT_MS,
	type WorkerToolResult,
	type WriteSectionToolDeps,
} from '../../../src/services/agent/agentWriteSection';
import type { AgentRetryInfo } from '../../../src/services/agent/agentRetry';
import {
	buildVerifyEnv,
	resolveOpenRouterKey,
	resolveVerifyEngine,
	VERIFY_ENGINE_DEFAULT,
} from '../../../src/services/agent/agentVerifyEngine';
import { composeSectionResultText } from '@uktub-root/src/agent/section-tool';
import type { SectionResult } from '@uktub-root/src/agent/section-writer';

const SYSTEM_PROMPT = 'You are a scientific research assistant.\n\n## Writing a document from the papers\nWrite every factual sentence with a cite.';

const LATEX = 'Cells age faster. \\cite{a}';

function unit(id: string, status: string, excerpt: string) {
	return { id, excerpt, status, suggested: [], pointers: [] as string[] };
}

function supportedPage() {
	return {
		units: [unit('u1', 'supported', 'Cells age faster.')],
		summary: { total: 1, from: 0, units: 1 },
		next: null,
	};
}

function docResult(page: unknown): WorkerToolResult {
	return {
		content: [{ type: 'text', text: 'document checked' }],
		structuredContent: page,
		details: {},
	};
}

interface Harness {
	tool: AgentTool;
	workerCalls: { name: string; args: Record<string, unknown>; signal?: AbortSignal; timeoutMs?: number }[];
	childAgents: Agent[];
	childToolNames: () => string[][];
	faux: ReturnType<typeof fauxProvider>;
}

function setup(
	responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
	verifyImpl?: (args: Record<string, unknown>, opts?: { signal?: AbortSignal }) => Promise<WorkerToolResult>,
	extra?: { onChildRetry?: (info: AgentRetryInfo) => void },
): Harness {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const workerCalls: Harness['workerCalls'] = [];
	const childAgents: Agent[] = [];
	const callWorkerTool = async (
		name: string,
		args: Record<string, unknown>,
		opts?: { signal?: AbortSignal; timeoutMs?: number },
	): Promise<WorkerToolResult> => {
		workerCalls.push({ name, args, signal: opts?.signal, timeoutMs: opts?.timeoutMs });
		if (name === 'passages') {
			return {
				content: [{ type: 'text', text: 'PASSAGE-POINTER doi@r#1-2: cells age faster in every trial.' }],
				structuredContent: null,
				details: {},
			};
		}
		if (verifyImpl) return verifyImpl(args, opts);
		return docResult(supportedPage());
	};
	const deps: WriteSectionToolDeps = {
		getModel: () => model,
		getApiKey: () => undefined,
		streamFn: models.streamSimple.bind(models),
		systemPrompt: SYSTEM_PROMPT,
		callWorkerTool,
		onChild: (child) => {
			childAgents.push(child);
		},
		...(extra?.onChildRetry ? { onChildRetry: extra.onChildRetry } : {}),
	};
	return {
		tool: buildWriteSectionTool(deps),
		workerCalls,
		childAgents,
		childToolNames: () => childAgents.map((c) => (c.state.tools as { name: string }[]).map((t) => t.name)),
		faux,
	};
}

const PARAMS = { goal: 'Say how cells age.', papers: 'a' };

describe('browser write_section tool (real child loop, faux provider)', () => {
	it('the child gets only passages and verify; forwards normalize papers like Pi', async () => {
		const h = setup([
			fauxAssistantMessage([fauxToolCall('passages', { query: 'cell aging' })]),
			fauxAssistantMessage([fauxToolCall('verify', { claim: 'Cells age.', continuation: '' })]),
			fauxAssistantMessage(LATEX),
		]);
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(h.childToolNames()).toEqual([['passages', 'verify']]);
		const passagesCall = h.workerCalls.find((c) => c.name === 'passages');
		expect(passagesCall?.args).toEqual({ query: 'cell aging', papers: 'all' });
		const claimVerify = h.workerCalls.find(
			(c) => c.name === 'verify' && typeof (c.args as { claim?: unknown }).claim === 'string',
		);
		// Empty continuations are dropped; scope defaults to all (Pi parity).
		expect(claimVerify?.args).toEqual({ claim: 'Cells age.', papers: 'all' });
		expect((out.content[0] as { text: string }).text).toContain(LATEX);
	});

	it('the child system prompt is the shared rules plus the workflow (Pi child parity)', async () => {
		const h = setup([fauxAssistantMessage(LATEX)]);
		await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(h.childAgents.length).toBe(1);
		expect(h.childAgents[0].state.systemPrompt).toBe(SYSTEM_PROMPT);
	});

	it('prepareArguments coerces array papers into the one-string form (Pi parity)', async () => {
		const h = setup([fauxAssistantMessage(LATEX)]);
		const prepared = h.tool.prepareArguments?.({ goal: 'g', papers: ['a', 'b'] });
		expect(prepared).toEqual({ goal: 'g', papers: 'a b' });
	});

	it('result text composition equals the shared function output for the same inputs', async () => {
		const h = setup([fauxAssistantMessage([fauxToolCall('passages', { query: 'cell aging' })]), fauxAssistantMessage(LATEX)]);
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		const d = out.details as {
			firstDraft: SectionResult['firstDraft'];
			final: SectionResult['final'];
			repaired: boolean;
			words: number;
		};
		const rebuilt: SectionResult = {
			latex: LATEX,
			summary: '1/1 supported (incomplete: 0), no repair needed.',
			unresolved: [],
			firstDraft: d.firstDraft,
			final: d.final,
			repaired: d.repaired,
			words: d.words,
		};
		expect((out.content[0] as { text: string }).text).toBe(composeSectionResultText(rebuilt));
		expect(d.firstDraft).toEqual({ units: 1, ok: 1, incomplete: 0 });
		expect(d.final).toEqual({ units: 1, ok: 1, incomplete: 0 });
		expect(d.repaired).toBe(false);
		expect(typeof d.words).toBe('number');
		const child = (out.details as { child?: { turns: number; toolCalls: number } }).child;
		expect(child?.turns).toBeGreaterThanOrEqual(1);
		// Browser-transport budgets ride every worker call (Pi has no RPC hop).
		expect(WRITE_SECTION_FORWARD_TIMEOUT_MS).toBe(300_000);
		expect(WRITE_SECTION_VERIFY_TIMEOUT_MS).toBe(600_000);
		expect(h.workerCalls.find((c) => c.name === 'passages')?.timeoutMs).toBe(300_000);
		expect(h.workerCalls.find((c) => c.name === 'verify')?.timeoutMs).toBe(600_000);
	});

	it('a verify refusal becomes the Pi refusal text as a tool error', async () => {
		const h = setup([fauxAssistantMessage(LATEX)], async () => ({
			content: [{ type: 'text', text: 'Refused' }],
			structuredContent: null,
			details: {
				refused: { code: 'VERIFY_ENGINE_MISSING', message: 'openrouter decisions engine: OPENROUTER_API_KEY is not set' },
			},
		}));
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(out.isError).toBe(true);
		expect((out.content[0] as { text: string }).text).toBe(
			'verify document mode refused (VERIFY_ENGINE_MISSING): openrouter decisions engine: OPENROUTER_API_KEY is not set',
		);
	});

	it('malformed verify output becomes the Pi malformed text as a tool error', async () => {
		const h = setup([fauxAssistantMessage(LATEX)], async () => ({
			content: [{ type: 'text', text: 'garbage' }],
			structuredContent: { nope: true },
			details: {},
		}));
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(out.isError).toBe(true);
		expect((out.content[0] as { text: string }).text).toBe(
			'verify document mode returned malformed output: refusing a partial set as complete',
		);
	});

	it('an already-aborted signal never creates the child', async () => {
		const h = setup([fauxAssistantMessage(LATEX)]);
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(h.tool.execute('call-1', { ...PARAMS }, ctrl.signal, undefined)).rejects.toThrow(/abort/i);
		expect(h.childAgents.length).toBe(0);
	});

	it('abort mid-run cancels the child and the in-flight worker call', async () => {
		let workerSignal: AbortSignal | undefined;
		let childAbortCalled = false;
		const h = setup([fauxAssistantMessage(LATEX)], (_args, opts) => {
			workerSignal = opts?.signal;
			return new Promise<WorkerToolResult>((_resolve, reject) => {
				workerSignal?.addEventListener('abort', () => reject(new Error('Operation aborted')));
			});
		});
		const ctrl = new AbortController();
		const pending = h.tool.execute('call-1', { ...PARAMS }, ctrl.signal, undefined);
		// Let the writer turn settle so the abort lands on the in-flight verify.
		await new Promise((r) => setTimeout(r, 50));
		const child = h.childAgents[0];
		const origAbort = child.abort.bind(child);
		child.abort = () => {
			childAbortCalled = true;
			origAbort();
		};
		ctrl.abort();
		await expect(pending).rejects.toThrow(/abort/i);
		expect(childAbortCalled).toBe(true);
		expect(workerSignal?.aborted).toBe(true);
	});

	it('a retryable child error retries once and lands in details.child.retries', async () => {
		const childRetries: AgentRetryInfo[] = [];
		const h = setup(
			[
				fauxAssistantMessage('', {
					stopReason: 'error',
					errorMessage: 'Rate limit exceeded: 429 free-models-per-min (OpenRouter free tier)',
				}),
				fauxAssistantMessage([fauxToolCall('passages', { query: 'cell aging' })]),
				fauxAssistantMessage(LATEX),
			],
			undefined,
			{ onChildRetry: (info) => void childRetries.push(info) },
		);
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(out.isError).not.toBe(true);
		expect((out.content[0] as { text: string }).text).toContain(LATEX);
		expect((out.details as { child: { retries: number } }).child.retries).toBe(1);
		expect(childRetries.length).toBe(1);
		expect(childRetries[0]).toMatchObject({ attempt: 1, maxAttempts: 3 });
	});

	it('a non-retryable child error fails without a retry', async () => {
		const childRetries: AgentRetryInfo[] = [];
		const h = setup(
			[fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Something broke badly.' })],
			undefined,
			{ onChildRetry: (info) => void childRetries.push(info) },
		);
		const out = await h.tool.execute('call-1', { ...PARAMS }, undefined, undefined);
		expect(out.isError).toBe(true);
		expect(childRetries.length).toBe(0);
		expect((out.details as { child: { retries: number } }).child.retries).toBe(0);
	});

	it('stop during the child retry wait aborts the tool at once', async () => {
		const childRetries: AgentRetryInfo[] = [];
		const ctrl = new AbortController();
		const h = setup(
			[
				fauxAssistantMessage('', {
					stopReason: 'error',
					errorMessage: 'Rate limit exceeded: 429 free-models-per-min (OpenRouter free tier)',
				}),
				fauxAssistantMessage(LATEX),
			],
			undefined,
			{
				onChildRetry: (info) => {
					childRetries.push(info);
					ctrl.abort();
				},
			},
		);
		await expect(h.tool.execute('call-1', { ...PARAMS }, ctrl.signal, undefined)).rejects.toThrow(/abort/i);
		expect(childRetries.length).toBe(1);
	});
});

describe('verification engine setting helpers', () => {
	it('default engine is openrouter (hosted is CORS-blocked in pages); openrouter pushes the key under both core names', () => {
		expect(VERIFY_ENGINE_DEFAULT).toBe('openrouter');
		expect(buildVerifyEnv({ engine: 'openrouter' })).toEqual({ UKTUB_VERIFY_ENGINE: 'openrouter' });
		expect(buildVerifyEnv({ engine: 'openrouter', openRouterKey: 'k' })).toEqual({
			UKTUB_VERIFY_ENGINE: 'openrouter',
			OPENROUTER_API_KEY: 'k',
			UKTUB_OPENROUTER_API_KEY: 'k',
		});
	});

	it('resolveVerifyEngine keeps a listed choice and visibly falls back from a stored hosted one', () => {
		expect(resolveVerifyEngine('openrouter', ['openrouter'])).toBe('openrouter');
		expect(resolveVerifyEngine('hosted', ['openrouter'])).toBe('openrouter');
		expect(resolveVerifyEngine(undefined, ['openrouter'])).toBe('openrouter');
		expect(resolveVerifyEngine('hosted', [])).toBe('openrouter');
	});

	it('the model-settings key applies only with explicit opt-in (default off)', () => {
		expect(resolveOpenRouterKey({ useModelKey: false, modelKey: 'm', separateKey: 's' })).toBe('s');
		expect(resolveOpenRouterKey({ useModelKey: true, modelKey: 'm', separateKey: 's' })).toBe('m');
		expect(resolveOpenRouterKey({ useModelKey: false })).toBeUndefined();
	});
});

describe('write_section child row summary', () => {
	it('renders turns, tool calls, words and draft/final counts; empty without stats', () => {
		expect(
			writeSectionChildSummary({
				details: {
					child: { turns: 3, toolCalls: 4 },
					words: 87,
					firstDraft: { ok: 5, units: 6, incomplete: 0 },
					final: { ok: 6, units: 6, incomplete: 0 },
				},
			}),
		).toBe('child: 3 turns, 4 tool calls, 87 words; first draft 5/6 supported; final 6/6');
		expect(writeSectionChildSummary({ details: {} })).toBe('');
		expect(writeSectionChildSummary(null)).toBe('');
	});
});
