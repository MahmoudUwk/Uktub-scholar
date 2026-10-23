// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9h requirement (TDD-first): verification settings survive a panel
// unmount/remount within the page session, and every setEnv push —
// including the mount-time one — sends the CURRENT settings, so the worker
// env after a remount equals the env before it.
//
// Shape: the real AgentPanel with a fake worker client recording setEnv
// calls. Configure openrouter + model-key opt-in + the paid decision model,
// unmount, remount: the last setEnv payload must still hold
// OPENROUTER_API_KEY and UKTUB_OPENROUTER_MODEL=inception/mercury-decide.
// RED today: the mount-time push sends literal defaults (opt-out, free
// model), silently dropping the key and the paid model.
import fs from 'node:fs';
import path from 'node:path';

import { createModels } from '@earendil-works/pi-ai';
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

import {
	clearAgentKeysForTest,
	setAgentKey,
} from '../../../src/services/agent/agentKeyStore';

const PAID_MODEL = 'inception/mercury-decide';

function buildModels() {
	const dataPath = path.join(
		__dirname,
		'../../../node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json',
	);
	const values = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as Record<
		string,
		Record<string, unknown>
	>;
	const classifiers = Object.values(values['typesafe-system-one'] ?? {});
	const chat = [
		{
			id: 'minimax/minimax-m3.1-flash:free',
			name: 'Test Flash',
			cost: { input: 0, output: 0 },
			contextWindow: 100000,
			maxTokens: 4000,
		},
	];
	const models = createModels();
	models.setProvider({
		id: 'openrouter',
		name: 'OpenRouter',
		auth: { apiKey: { name: 'OpenRouter API key' } },
		getModels: () => chat,
		getAllModels: () => classifiers,
	} as never);
	return models;
}

describe('phase 9h verify settings survive panel remount', () => {
	const setEnvCalls: Record<string, string>[] = [];
	const fakeClient = {
		agentSurface: async () => ({
			rules: ['You are the research writing assistant.'],
			workflow: null,
			tools: [],
			keyNames: [],
			compileTimeoutMs: 30000,
			verificationEngines: ['openrouter'],
		}),
		setEnv: async (env: Record<string, string>) => {
			setEnvCalls.push(env);
			return { ok: true };
		},
	};

	beforeEach(() => {
		window.localStorage.clear();
		clearAgentKeysForTest();
		setEnvCalls.length = 0;
		(getAgentModels as jest.Mock).mockResolvedValue(buildModels());
		(uktubProjectService.getClient as jest.Mock).mockReturnValue(fakeClient);
	});

	it('remount pushes the configured key and paid model, not the defaults', async () => {
		// Researcher key in memory (the "don't remember" rule: no localStorage).
		setAgentKey('openrouter', 'test-key-9h', { remember: false });
		expect(window.localStorage.getItem('uktub.agent.key.openrouter')).toBeNull();

		const first = render(<AgentPanel docUrl="doc-9h" />);
		await waitFor(() => expect(setEnvCalls.length).toBeGreaterThan(0));

		// Wait for the catalog-driven verify options (both mercury variants).
		await waitFor(() => {
			const el = document.querySelector(
				'[data-role="agent-verify-model-option"][data-model-id="inception/mercury-decide"]',
			);
			expect(el).not.toBeNull();
		});

		// Configure through the real UI: paid model + "use the model key".
		const modelSelect = document.querySelector(
			'[data-role="agent-verify-model-select"]',
		) as HTMLSelectElement;
		fireEvent.change(modelSelect, { target: { value: PAID_MODEL } });
		const useModelKey = document.querySelector(
			'[data-role="agent-verify-use-model-key"]',
		) as HTMLInputElement;
		fireEvent.click(useModelKey);

		await waitFor(() => {
			const last = setEnvCalls[setEnvCalls.length - 1] as Record<string, string>;
			expect(last['OPENROUTER_API_KEY']).toBe('test-key-9h');
			expect(last['UKTUB_OPENROUTER_MODEL']).toBe(PAID_MODEL);
		});

		// Sidebar switches views: the panel unmounts and remounts.
		first.unmount();
		const before = setEnvCalls.length;
		const second = render(<AgentPanel docUrl="doc-9h" />);
		await waitFor(() => expect(setEnvCalls.length).toBeGreaterThan(before));

		// THE 9h ASSERTION: the mount-time push kept the current settings.
		const last = setEnvCalls[setEnvCalls.length - 1] as Record<string, string>;
		expect(last['UKTUB_VERIFY_ENGINE']).toBe('openrouter');
		expect(last['OPENROUTER_API_KEY']).toBe('test-key-9h');
		expect(last['UKTUB_OPENROUTER_MODEL']).toBe(PAID_MODEL);

		// The UI shows the same settings after the remount.
		expect(
			(document.querySelector(
				'[data-role="agent-verify-model-select"]',
			) as HTMLSelectElement).value,
		).toBe(PAID_MODEL);
		expect(
			(document.querySelector(
				'[data-role="agent-verify-use-model-key"]',
			) as HTMLInputElement).checked,
		).toBe(true);

		second.unmount();
	});
});
