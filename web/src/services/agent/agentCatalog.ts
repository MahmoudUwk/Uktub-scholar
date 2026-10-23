// SPDX-License-Identifier: AGPL-3.0-or-later
// Catalog view model for the agent panel's model picker.
//
// Nothing is hardcoded: providers and models come from pi-ai's built-in
// catalog (builtinModels()). Every provider is shown; a provider without
// apiKey auth (OAuth-only) is flagged sign-in-only and disabled in v1.

import type { Model, Provider } from '@earendil-works/pi-ai';

export interface AgentModelView {
	providerId: string;
	id: string;
	name: string;
	contextWindow: number;
	maxTokens: number;
	costInput: number;
	costOutput: number;
	free: boolean;
}

export interface AgentProviderView {
	id: string;
	name: string;
	/** e.g. "OpenRouter API key"; null when the provider has no apiKey auth. */
	keyLabel: string | null;
	/** True when the provider has no apiKey auth (OAuth-only): shown disabled. */
	signInOnly: boolean;
	models: AgentModelView[];
}

export interface AgentCatalogSource {
	getProviders(): readonly Provider[];
	getModels(providerId: string): readonly Model<string>[];
}

function toModelView(providerId: string, m: Model<string>): AgentModelView {
	const costInput = m.cost?.input ?? NaN;
	const costOutput = m.cost?.output ?? NaN;
	return {
		providerId,
		id: m.id,
		name: m.name || m.id,
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		costInput,
		costOutput,
		free: costInput === 0 && costOutput === 0,
	};
}

export function buildAgentCatalogView(source: AgentCatalogSource): AgentProviderView[] {
	return source.getProviders().map((p) => ({
		id: p.id,
		name: p.name || p.id,
		keyLabel: p.auth.apiKey?.name ?? null,
		signInOnly: !p.auth.apiKey,
		models: source.getModels(p.id).map((m) => toModelView(p.id, m)),
	}));
}

export function countCatalogModels(view: AgentProviderView[]): number {
	return view.reduce((n, p) => n + p.models.length, 0);
}
