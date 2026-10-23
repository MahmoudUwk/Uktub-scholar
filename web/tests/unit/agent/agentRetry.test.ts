// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9d (TDD-first): browser auto-retry against the REAL pi-agent-core
// loop with the pi-ai faux provider (no network).
//
// Pi parity under test: the same predicate (`isRetryableAssistantError`),
// the same default policy (enabled, maxRetries 3, baseDelayMs 2000,
// exponential backoff, 60 s cap), the same omit-the-failed-attempt
// behavior, Stop aborting a pending retry wait at once, and error turns
// never consuming a gate follow-up.
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';

import { AGENT_RETRY_POLICY, withAgentRetry, type AgentRetryInfo } from '../../../src/services/agent/agentRetry';

const RATE_LIMIT = 'Rate limit exceeded: 429 free-models-per-min (OpenRouter free tier, 20 requests/min)';

function failedRateLimit(): ReturnType<typeof fauxAssistantMessage> {
	return fauxAssistantMessage('', { stopReason: 'error', errorMessage: RATE_LIMIT });
}

interface Run {
	agent: Agent;
	retries: AgentRetryInfo[];
	finishTurns: { stopReason?: string }[];
	assistantTexts: string[];
	faux: ReturnType<typeof fauxProvider>;
}

function setup(
	responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
	policy?: Partial<typeof AGENT_RETRY_POLICY>,
): Run {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();
	const retries: AgentRetryInfo[] = [];
	const finishTurns: { stopReason?: string }[] = [];
	const assistantTexts: string[] = [];
	const agent = new Agent({
		initialState: { systemPrompt: 'You are a test assistant.', model: model as never, tools: [], messages: [] },
		streamFn: withAgentRetry(models.streamSimple.bind(models), {
			...(policy !== undefined ? { policy } : {}),
			onRetry: (info) => {
				retries.push(info);
			},
		}),
		finishTurn: (turn) => {
			finishTurns.push({ stopReason: (turn.message as unknown as { stopReason?: string }).stopReason });
			return undefined;
		},
	});
	agent.subscribe((event: AgentEvent) => {
		if (event.type === 'message_end' && event.message.role === 'assistant') {
			const text = event.message.content
				.filter((b) => b.type === 'text')
				.map((b) => (b as { text: string }).text)
				.join('');
			assistantTexts.push(text);
		}
	});
	return { agent, retries, finishTurns, assistantTexts, faux };
}

describe('browser agent auto-retry (Pi parity)', () => {
	it('mirrors the Pi default policy values', () => {
		expect(AGENT_RETRY_POLICY).toEqual({ enabled: true, maxRetries: 3, baseDelayMs: 2000, maxAgentDelayMs: 60_000 });
	});

	it('a retryable error then success retries once and succeeds', async () => {
		const run = setup([failedRateLimit(), fauxAssistantMessage('done.')], { baseDelayMs: 5, maxAgentDelayMs: 50 });
		await run.agent.prompt('go');
		expect(run.assistantTexts).toEqual(['done.']);
		expect(run.retries.length).toBe(1);
		expect(run.retries[0]).toMatchObject({ attempt: 1, maxAttempts: 3, delayMs: 5 });
		expect(run.retries[0]?.errorMessage).toContain('429');
		expect(run.faux.getPendingResponseCount()).toBe(0);
		// The failed attempt never reaches the turn end: one completed turn.
		expect(run.finishTurns.length).toBe(1);
		expect(run.finishTurns[0]?.stopReason).toBe('stop');
	});

	it('a non-retryable error never retries', async () => {
		const run = setup([fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Something broke badly.' })], {
			baseDelayMs: 5,
		});
		await run.agent.prompt('go');
		expect(run.retries.length).toBe(0);
		expect(run.finishTurns.length).toBe(1);
		expect(run.finishTurns[0]?.stopReason).toBe('error');
		expect(run.faux.state.callCount).toBe(1);
	});

	it('Stop during the retry wait idles at once with no further request', async () => {
		const run = setup([failedRateLimit(), fauxAssistantMessage('late.')], { baseDelayMs: 30_000 });
		let stopReason: string | undefined;
		const sub = run.agent.subscribe((event: AgentEvent) => {
			if (event.type === 'message_end' && event.message.role === 'assistant') {
				stopReason = (event.message as { stopReason?: string }).stopReason;
			}
		});
		const pending = run.agent.prompt('go');
		// Wait for the retry to be scheduled, then Stop mid-wait.
		const start = Date.now();
		while (run.retries.length === 0 && Date.now() - start < 5000) {
			await new Promise((r) => setTimeout(r, 10));
		}
		expect(run.retries.length).toBe(1);
		run.agent.abort();
		await pending;
		sub();
		expect(stopReason).toBe('aborted');
		expect(run.faux.state.callCount).toBe(1);
		expect(run.faux.getPendingResponseCount()).toBe(1);
	});

	it('an exhausted error turn never consumes a gate follow-up', async () => {
		const run = setup(
			[
				failedRateLimit(),
				failedRateLimit(),
				failedRateLimit(),
				failedRateLimit(),
				fauxAssistantMessage('never.'),
			],
			{ baseDelayMs: 5, maxAgentDelayMs: 50 },
		);
		let followUps = 0;
		const agent = run.agent;
		const origFollowUp = agent.followUp.bind(agent);
		agent.followUp = ((message: never) => {
			followUps++;
			return origFollowUp(message);
		}) as typeof agent.followUp;
		await agent.prompt('go');
		// maxRetries 3: one initial + 3 retries, all failing; the error turn
		// ends the run with exactly one error turn and no continuation.
		expect(run.retries.length).toBe(3);
		expect(run.faux.state.callCount).toBe(4);
		expect(run.assistantTexts.length).toBe(1);
		expect(followUps).toBe(0);
	});
});
