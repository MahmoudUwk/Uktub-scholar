// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9i requirement test (TDD-first): the `write_section` child carries a
// stable session id derived from the parent's, on every stream call of the
// child run. Drives the real tool (real child Agent loop, faux provider)
// with a stream wrapper that records the options the loop passes down.
//
// RED today: the tool builds its child with no `sessionId`, so every
// recorded option is `undefined`.
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { buildWriteSectionTool, writeSectionChildSummary } from '../../../src/services/agent/agentWriteSection';
import type { CoreToolResult } from '../../../src/services/agent/agentUktubTools';

const LATEX = 'Cells age faster. \\cite{a}';

function unit(id: string, status: string, excerpt: string) {
	return { id, excerpt, status, suggested: [], pointers: [] as string[] };
}

function docResult(page: unknown): CoreToolResult {
	return {
		content: [{ type: 'text', text: 'document checked' }],
		structuredContent: page,
		details: {},
	} as unknown as CoreToolResult;
}

describe('phase 9i write_section child session id', () => {
	it('sends the derived child id on every stream call of one child run', async () => {
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall('passages', { query: 'cell aging' })]),
			fauxAssistantMessage([fauxToolCall('verify', { claim: 'Cells age.', continuation: '' })]),
			fauxAssistantMessage(LATEX),
		]);
		const seen: (string | undefined)[] = [];
		const inner = models.streamSimple.bind(models);
		const recording: typeof inner = (model, context, options) => {
			seen.push((options as { sessionId?: string } | undefined)?.sessionId);
			return inner(model, context, options);
		};

		const childAgents: Agent[] = [];
		const tool = buildWriteSectionTool({
			getModel: () => faux.getModel(),
			getApiKey: () => undefined,
			streamFn: recording,
			systemPrompt: 'You are a scientific research assistant.',
			getSessionId: () => 'parent-sid-9i',
			callWorkerTool: async (name: string): Promise<CoreToolResult> => {
				if (name === 'passages') {
					return {
						content: [{ type: 'text', text: 'PASSAGE-POINTER doi@r#1-2: cells age faster.' }],
						structuredContent: null,
						details: {},
					} as unknown as CoreToolResult;
				}
				return docResult({
					units: [unit('u1', 'supported', 'Cells age faster.')],
					summary: { total: 1, from: 0, units: 1 },
					next: null,
				});
			},
			onChild: (child) => {
				childAgents.push(child);
			},
		}) as AgentTool;

		const out = (await tool.execute('call-9i', { goal: 'Say how cells age.', papers: 'a' }, undefined)) as {
			isError?: boolean;
		};
		expect(out.isError).not.toBe(true);
		expect(childAgents.length).toBe(1);
		// The child makes several stream calls (draft, repair check path);
		// every one carries the same non-empty id derived from the parent's.
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toBe('parent-sid-9i:ws1');
		for (const id of seen) expect(id).toBe(seen[0]);

		// A second invocation gets its own stable child id, still derived
		// from the same parent.
		faux.setResponses([fauxAssistantMessage(LATEX)]);
		seen.length = 0;
		const out2 = (await tool.execute('call-9i-2', { goal: 'Say how cells age.', papers: 'a' }, undefined)) as {
			isError?: boolean;
		};
		expect(out2.isError).not.toBe(true);
		expect(seen.length).toBeGreaterThan(0);
		expect(seen[0]).toBe('parent-sid-9i:ws2');
		for (const id of seen) expect(id).toBe(seen[0]);
	});
});

describe('phase 9i write_section row carries the child usage', () => {
	it('appends the child usage totals to the row summary', () => {
		const summary = writeSectionChildSummary({
			details: {
				child: {
					turns: 3,
					toolCalls: 4,
					usage: { input: 5230, output: 410, cacheRead: 4900, cacheWrite: 0, costUsd: 0.0008 },
				},
				words: 120,
				firstDraft: { ok: 7, units: 10 },
				final: { ok: 10, units: 10 },
			},
		});
		expect(summary).toContain('child: 3 turns');
		expect(summary).toContain('5,230');
		expect(summary).toContain('4,900');
	});
});
