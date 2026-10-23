// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 8a Part B (TDD-first): the page adapter's gate wiring against the
// REAL pi-agent-core loop with the pi-ai faux provider (no network).
//
// The gate text queue below stands in for the worker's `gateSettle` RPC (its
// real texts are pinned byte-identical by `tests-browser/gate-parity.spec.ts`);
// every assertion here is on observable run behavior (message counts, roles,
// transcript rows, `agent_end` count), never on mock calls or source text.
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { createGateAdapter } from '../../../src/services/agent/agentCompletionGate';

const GATE_TEXT =
	'Before finishing: 1 statement(s) in manuscript/main.tex are neither verified as written nor labelled unverified:\n- L1 "Alpha rose 4%."\nResolve each: verify it, rewrite it from a passage of its cited paper, delete it, or mark it with the word "unverified". Then recompile and list what remains unverified in your final answer.';
const GATE_TEXT_2 =
	'Before finishing: these citation keys are not in the registry: madeup2026\nRegister each paper that exists with its DOI or arXiv id, otherwise remove that \\cite and keep the statement only if it is marked with the word "unverified". Then recompile.';

function assistantText(event: AgentEvent): string | null {
	if (event.type !== 'message_end' || event.message.role !== 'assistant') return null;
	if (event.message.content.some((block) => block.type === 'toolCall')) return null;
	const text = event.message.content
		.filter((block) => block.type === 'text')
		.map((block) => (block as { text: string }).text)
		.join('');
	return text === '' ? null : text;
}

function makeWriteTool(): AgentTool {
	return {
		name: 'write',
		description: 'write a project file',
		parameters: { type: 'object', properties: { path: { type: 'string' } } },
		execute: async (_toolCallId: string, params: unknown) => ({
			content: [
				{
					type: 'text',
					text: `wrote ${(params as { path?: string } | null)?.path ?? ''}`,
				},
			],
			details: {},
		}),
	} as unknown as AgentTool;
}

interface GateRun {
	agent: Agent;
	adapter: ReturnType<typeof createGateAdapter>;
	checkMessages: string[];
	toolEndedCalls: { toolName: string; args: unknown; isError: boolean }[];
	assistantTexts: string[];
	agentEnds: () => number;
	startPrompts: () => number;
	pendingResponses: () => number;
	armGateTexts: (texts: (string | null)[]) => void;
}

function setupGateRun(
	responses: Parameters<ReturnType<typeof fauxProvider>['setResponses']>[0],
	tools: AgentTool[] = [],
): GateRun {
	const faux = fauxProvider();
	const models = createModels();
	models.setProvider(faux.provider);
	faux.setResponses(responses);
	const model = faux.getModel();

	const checkMessages: string[] = [];
	const toolEndedCalls: GateRun['toolEndedCalls'] = [];
	const assistantTexts: string[] = [];
	let agentEnds = 0;
	let startPrompts = 0;
	let gateTexts: (string | null)[] = [];
	let agent: Agent;
	const adapter = createGateAdapter({
		gateStartUserPrompt: () => {
			startPrompts++;
		},
		gateToolEnded: (event) => {
			toolEndedCalls.push({ ...event });
		},
		gateSettle: () => ({ text: gateTexts.length > 0 ? (gateTexts.shift() as string | null) : null }),
		addCheckMessage: (text) => {
			checkMessages.push(text);
		},
		followUp: (message) => {
			agent.followUp(message);
		},
	});
	agent = new Agent({
		initialState: { systemPrompt: 'test assistant', model, thinkingLevel: 'off', tools, messages: [] },
		streamFn: models.streamSimple.bind(models),
		finishTurn: (turn) => adapter.finishTurn(turn),
	});
	agent.subscribe((event: AgentEvent) => {
		if (event.type === 'tool_execution_start') {
			adapter.rememberToolStart(event.toolCallId, event.args);
		} else if (event.type === 'tool_execution_end') {
			void adapter.recordToolEnd(event.toolCallId, event.toolName, event.isError).catch(() => {});
		} else if (event.type === 'agent_end') {
			agentEnds++;
		}
		const text = assistantText(event);
		if (text !== null) assistantTexts.push(text);
	});
	return {
		agent,
		adapter,
		checkMessages,
		toolEndedCalls,
		assistantTexts,
		agentEnds: () => agentEnds,
		startPrompts: () => startPrompts,
		pendingResponses: () => faux.getPendingResponseCount(),
		armGateTexts: (texts) => {
			gateTexts = [...texts];
		},
	};
}

function userMessages(run: GateRun): { role?: string; content?: unknown }[] {
	return (run.agent.state.messages as unknown as { role?: string; content?: unknown }[]).filter(
		(m) => m.role === 'user',
	);
}

describe('agent completion-gate adapter (finishTurn + followUp)', () => {
	it('(a) a tex edit followed by an answer continues exactly once in the same run', async () => {
		const run = setupGateRun(
			[
				fauxAssistantMessage([fauxToolCall('write', { path: 'manuscript/main.tex' })]),
				fauxAssistantMessage('Edited and done.'),
				fauxAssistantMessage('All statements verified.'),
			],
			[makeWriteTool()],
		);
		run.armGateTexts([GATE_TEXT]);
		await run.adapter.startUserPrompt();
		await run.agent.prompt('edit the manuscript');
		expect(run.agentEnds()).toBe(1);
		expect(run.assistantTexts).toEqual(['Edited and done.', 'All statements verified.']);
		expect(run.checkMessages).toEqual([GATE_TEXT]);
		const injected = userMessages(run).filter((m) => m.content === GATE_TEXT);
		expect(injected.length).toBe(1);
		expect(run.toolEndedCalls).toEqual([
			{ toolName: 'write', args: { path: 'manuscript/main.tex' }, isError: false },
		]);
	});

	it('(b) a second finding continues once more, a third does not; the next prompt resets', async () => {
		const run = setupGateRun(
			[
				fauxAssistantMessage([fauxToolCall('write', { path: 'manuscript/main.tex' })]),
				fauxAssistantMessage('First answer.'),
				fauxAssistantMessage('Second answer.'),
				fauxAssistantMessage('Third answer.'),
				fauxAssistantMessage('Fresh answer.'),
				fauxAssistantMessage('Fresh follow-up answer.'),
			],
			[makeWriteTool()],
		);
		run.armGateTexts([GATE_TEXT, GATE_TEXT_2]);
		await run.adapter.startUserPrompt();
		await run.agent.prompt('edit the manuscript');
		expect(run.agentEnds()).toBe(1);
		expect(run.assistantTexts).toEqual(['First answer.', 'Second answer.', 'Third answer.']);
		expect(run.checkMessages).toEqual([GATE_TEXT, GATE_TEXT_2]);
		// The third settle was silent: run 1 left run 2's responses untouched.
		expect(run.pendingResponses()).toBe(2);
		// The counter resets on the next user prompt: a new finding continues once more.
		run.armGateTexts([GATE_TEXT]);
		await run.adapter.startUserPrompt();
		await run.agent.prompt('another question');
		expect(run.agentEnds()).toBe(2);
		expect(run.assistantTexts).toEqual([
			'First answer.',
			'Second answer.',
			'Third answer.',
			'Fresh answer.',
			'Fresh follow-up answer.',
		]);
		expect(run.checkMessages).toEqual([GATE_TEXT, GATE_TEXT_2, GATE_TEXT]);
		expect(run.pendingResponses()).toBe(0);
	});

	it('(c) a run that never touched a tex file and never compiled is never continued', async () => {
		const run = setupGateRun([fauxAssistantMessage('Just chatting.')]);
		await run.adapter.startUserPrompt();
		await run.agent.prompt('hello');
		expect(run.agentEnds()).toBe(1);
		expect(run.assistantTexts).toEqual(['Just chatting.']);
		expect(run.checkMessages).toEqual([]);
		expect(userMessages(run).length).toBe(1);
	});

	it('(d) Stop during the continued turn ends the run cleanly', async () => {
		const run = setupGateRun([
			fauxAssistantMessage('First.'),
			fauxAssistantMessage('word '.repeat(200)),
		]);
		run.armGateTexts([GATE_TEXT]);
		let assistantStarts = 0;
		run.agent.subscribe((event: AgentEvent) => {
			if (event.type === 'message_start' && (event.message as { role?: string }).role === 'assistant') {
				assistantStarts++;
				if (assistantStarts === 2) run.agent.abort();
			}
		});
		await run.adapter.startUserPrompt();
		// Abort during the continued turn: prompt() itself resolves (the loop
		// ends with an aborted turn and one agent_end); the panel treats an
		// abort-shaped rejection as idle, so resolving is the clean outcome.
		await run.agent.prompt('hello');
		expect(run.agentEnds()).toBe(1);
		expect(run.checkMessages).toEqual([GATE_TEXT]);
		expect(run.agent.state.isStreaming).toBe(false);
	});
});
