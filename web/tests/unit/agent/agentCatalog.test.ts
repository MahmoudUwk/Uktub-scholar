// SPDX-License-Identifier: AGPL-3.0-or-later
// buildAgentCatalogView is pure: it derives the picker view from whatever
// source implements the Models read API. The REAL pi-ai catalog cannot be
// imported by this Jest setup (pi-ai 1.3.0 ships ESM-only: its exports map
// has "import" conditions only, which ts-jest/CommonJS cannot require), so
// the real catalog is covered instead by the Phase 5 acceptance run, which
// compares the picker's provider count against
// builtinModels().getProviders().length computed in Node.
import {
	buildAgentCatalogView,
	countCatalogModels,
	type AgentCatalogSource,
} from '../../../src/services/agent/agentCatalog';

function fakeSource(): AgentCatalogSource {
	return {
		getProviders: () => [
			{ id: 'openrouter', name: 'OpenRouter', auth: { apiKey: { name: 'OpenRouter API key' } } },
			{ id: 'keyless', name: 'Keyless', auth: {} },
		],
		getModels: (providerId: string) =>
			providerId === 'openrouter'
				? [
						{
							id: 'free-model',
							name: 'Free Model',
							contextWindow: 100000,
							maxTokens: 4000,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
						},
						{
							id: 'paid-model',
							name: '',
							contextWindow: 200000,
							maxTokens: 8000,
							cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
						},
					]
				: [],
	} as unknown as AgentCatalogSource;
}

describe('agentCatalog view model', () => {
	it('lists every provider from the source with no allowlist', () => {
		const view = buildAgentCatalogView(fakeSource());
		expect(view.map((p) => p.id).sort()).toEqual(['keyless', 'openrouter']);
	});

	it('derives the key label from auth and flags keyless providers sign-in-only', () => {
		const view = buildAgentCatalogView(fakeSource());
		const or = view.find((p) => p.id === 'openrouter');
		expect(or?.keyLabel).toBe('OpenRouter API key');
		expect(or?.signInOnly).toBe(false);
		const keyless = view.find((p) => p.id === 'keyless');
		expect(keyless?.keyLabel).toBeNull();
		expect(keyless?.signInOnly).toBe(true);
	});

	it('shows per-model name/id, context window and cost; falls back to id for an empty name', () => {
		const view = buildAgentCatalogView(fakeSource());
		const or = view.find((p) => p.id === 'openrouter');
		expect(or?.models).toHaveLength(2);
		expect(or?.models[0]).toMatchObject({
			id: 'free-model',
			name: 'Free Model',
			contextWindow: 100000,
			maxTokens: 4000,
			costInput: 0,
			costOutput: 0,
			free: true,
		});
		expect(or?.models[1].name).toBe('paid-model');
		expect(or?.models[1].free).toBe(false);
	});

	it('counts models across providers', () => {
		expect(countCatalogModels(buildAgentCatalogView(fakeSource()))).toBe(2);
	});
});
