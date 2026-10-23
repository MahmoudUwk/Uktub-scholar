// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9i requirement tests (TDD-first): the parent agent sends a stable
// non-empty `sessionId` on every stream call, and every assistant message's
// usage lands on the transcript as a compact usage line.
//
// Shape: the real AgentPanel with mocked models (faux provider, canned text
// replies) and a fake worker client. Two sends through the UI: both stream
// calls must carry the same session id, and two usage lines must render.
//
// RED today: no `sessionId` reaches the stream calls (all `undefined`) and
// no usage line renders.
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux';
import { fireEvent, render, waitFor } from '@testing-library/react';

jest.mock('../../../src/services/agent/agentModels', () => ({
	getAgentModels: jest.fn(),
}));

jest.mock('../../../src/services/UktubProjectService', () => ({
	uktubProjectService: {
		getClient: jest.fn(),
		flush: jest.fn(async () => undefined),
		refreshAgentPaths: jest.fn(async () => undefined),
	},
}));

jest.mock('../../../src/hooks/useLaTeX', () => ({
	useLaTeX: () => ({
		compileForAgent: jest.fn(),
		stopCompilation: jest.fn(),
	}),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAgentModels } = require('../../../src/services/agent/agentModels');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { uktubProjectService } = require('../../../src/services/UktubProjectService');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AgentPanel = require('../../../src/components/agent/AgentPanel').default;

const SURFACE_TOOL = {
	name: 'registry',
	description: 'Registry tool',
	inputSchema: { type: 'object', properties: {} },
};

function buildHarness() {
	const models = createModels();
	const faux = fauxProvider();
	models.setProvider(faux.provider);
	faux.setResponses([fauxAssistantMessage('First reply.'), fauxAssistantMessage('Second reply.')]);
	const seen: (string | undefined)[] = [];
	const inner = models.streamSimple.bind(models);
	models.streamSimple = ((model: never, context: never, options?: { sessionId?: string }) => {
		seen.push(options?.sessionId);
		return inner(model, context, options as never);
	}) as typeof models.streamSimple;
	return { models, seen };
}

const fakeClient = {
	agentSurface: async () => ({
		rules: ['You are the research writing assistant.'],
		workflow: null,
		tools: [SURFACE_TOOL],
		keyNames: [],
		compileTimeoutMs: null,
		verificationEngines: ['openrouter'],
	}),
	setEnv: async () => ({ ok: true }),
	callTool: async () => ({ content: [{ type: 'text', text: '{}' }], details: {} }),
	gateStartUserPrompt: async () => undefined,
	gateToolEnded: async () => undefined,
	gateSettle: async () => ({ text: null }),
};

async function sendAndIdle(text: string): Promise<void> {
	fireEvent.change(document.querySelector('[data-role="agent-input"]') as HTMLInputElement, {
		target: { value: text },
	});
	fireEvent.click(document.querySelector('[data-role="agent-send"]') as HTMLButtonElement);
	await waitFor(
		() => expect(document.querySelector('[data-role="agent-stop"]')).toBeNull(),
		{ timeout: 15000 },
	);
}

describe('phase 9i parent session id and usage lines', () => {
	beforeEach(() => {
		window.localStorage.clear();
		(uktubProjectService.getClient as jest.Mock).mockReturnValue(fakeClient);
	});

	it('sends one stable session id across turns and renders a usage line per reply', async () => {
		const { models, seen } = buildHarness();
		(getAgentModels as jest.Mock).mockResolvedValue(models);

		render(<AgentPanel docUrl="doc-9i" />);
		await waitFor(() => expect(document.querySelector('[data-role="agent-input"]')).not.toBeNull());

		await sendAndIdle('Hello agent.');
		await sendAndIdle('Again.');

		// (a) every parent stream call carries the same non-empty session id.
		expect(seen.length).toBeGreaterThanOrEqual(2);
		expect(typeof seen[0]).toBe('string');
		expect((seen[0] as string).length).toBeGreaterThan(0);
		for (const id of seen) expect(id).toBe(seen[0]);

		// (b) each assistant reply shows its compact usage line with real numbers.
		const lines = [...document.querySelectorAll('[data-role="agent-usage-line"]')];
		expect(lines.length).toBeGreaterThanOrEqual(2);
		expect(lines[0].textContent).toMatch(/tokens: .* in .* · .* out/);
	});
});
