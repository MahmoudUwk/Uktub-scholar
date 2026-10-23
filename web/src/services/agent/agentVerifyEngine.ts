// SPDX-License-Identifier: AGPL-3.0-or-later
// Verification-engine setting (Phase 8b): the engine list comes from the
// worker's agentSurface().verificationEngines (core-derived, fetch-runnable
// only); the choice is pushed to the worker with setEnv as
// UKTUB_VERIFY_ENGINE. `setEnv` REPLACES the worker env, so every push must
// merge research keys and verify settings into one object (see AgentPanel).
//
// Key discrepancy (core, unchangeable here): the openrouter engine reads
// OPENROUTER_API_KEY (`src/core/verify/claim.ts`) while doctor checks
// UKTUB_OPENROUTER_API_KEY (`src/core/tools/doctor.ts`). The panel pushes
// the researcher's key under BOTH names so the engine runs and doctor
// reports it ready; both live in worker memory only, never logged/echoed.
//
// Phase 9g: the openrouter engine reads its decision model from
// UKTUB_OPENROUTER_MODEL (core default below); the panel offers the choice
// dynamically from pi-ai's catalog (see listVerifyModels) and pushes it
// with the same env merge. Doctor's verification line names no model, so
// there is nothing to reflect there (core untouched).
import type { Models } from '@earendil-works/pi-ai';

export const VERIFY_ENGINE_ENV = 'UKTUB_VERIFY_ENGINE';
export const OPENROUTER_KEY_ENV = 'OPENROUTER_API_KEY';
export const OPENROUTER_DOCTOR_KEY_ENV = 'UKTUB_OPENROUTER_API_KEY';
export const VERIFY_ENGINE_DEFAULT = 'openrouter';

/** Pushed as UKTUB_OPENROUTER_MODEL when the engine is openrouter. */
export const VERIFY_MODEL_ENV = 'UKTUB_OPENROUTER_MODEL';
/** Mirrors core DEFAULT_OPENROUTER_MODEL (src/core/verify/engines.ts). */
export const VERIFY_MODEL_DEFAULT = 'inception/mercury-decide:free';

// Phase 9f: `hosted` is CORS-blocked in pages (measured 2026-10-22 from
// real Chromium), so the browser default is `openrouter` and a stored
// `hosted` choice from an older session visibly falls back to the first
// offered engine instead of selecting an unreachable one.
export function resolveVerifyEngine(
	stored: string | undefined,
	engines: string[],
	fallback: string = VERIFY_ENGINE_DEFAULT,
): string {
	if (stored && engines.includes(stored)) return stored;
	if (engines.includes(fallback)) return fallback;
	return engines[0] ?? fallback;
}

export interface VerifyEnvOptions {
	engine: string;
	/** The OpenRouter key to use when engine is openrouter; absent means none. */
	openRouterKey?: string;
	/** The decision model to use when engine is openrouter; absent means the core default. */
	verifyModel?: string;
}

export function buildVerifyEnv(opts: VerifyEnvOptions): Record<string, string> {
	const env: Record<string, string> = { [VERIFY_ENGINE_ENV]: opts.engine };
	if (opts.engine === 'openrouter' && opts.openRouterKey) {
		env[OPENROUTER_KEY_ENV] = opts.openRouterKey;
		env[OPENROUTER_DOCTOR_KEY_ENV] = opts.openRouterKey;
	}
	if (opts.engine === 'openrouter' && opts.verifyModel) {
		env[VERIFY_MODEL_ENV] = opts.verifyModel;
	}
	return env;
}

/** Which OpenRouter key applies: the model-settings key only when the researcher explicitly opts in (default off). */
export function resolveOpenRouterKey(opts: {
	useModelKey: boolean;
	modelKey?: string;
	separateKey?: string;
}): string | undefined {
	if (opts.useModelKey) return opts.modelKey;
	return opts.separateKey;
}

export interface VerifyModelOption {
	id: string;
	name: string;
	free: boolean;
	priceLabel: string;
}

/** Price label from the catalog cost: `free`, or `$X/M input` ($ per million input tokens). */
export function formatVerifyModelPrice(cost?: { input?: number; output?: number }): string {
	const ci = cost?.input ?? NaN;
	const co = cost?.output ?? NaN;
	if (ci === 0 && co === 0) return 'free';
	if (Number.isFinite(ci)) {
		const n = ci as number;
		return `$${Number.isInteger(n) ? String(n) : n.toFixed(2)}/M input`;
	}
	return 'price unknown';
}

/**
 * Phase 9g: the OpenRouter classifier models the core `openrouter`
 * decisions engine can use, listed dynamically from pi-ai's catalog (no
 * model ids hardcoded here). The catalog marks them `type: 'classifier'`
 * with the `typesafe-system-one` API on the `openrouter` provider; the
 * free tier shows cost 0, the paid decision model its $/M input price.
 */
export function listVerifyModels(models: Pick<Models, 'getModelsOfType'> | null | undefined): VerifyModelOption[] {
	if (!models) return [];
	return models.getModelsOfType('classifier', 'openrouter').map((m) => {
		const free = (m.cost?.input ?? NaN) === 0 && (m.cost?.output ?? NaN) === 0;
		return {
			id: m.id,
			name: m.name || m.id,
			free,
			priceLabel: formatVerifyModelPrice(m.cost),
		};
	});
}

/** A stored choice stays only when the catalog still lists it; otherwise the core default. */
export function resolveVerifyModel(
	stored: string | undefined,
	options: VerifyModelOption[],
	fallback: string = VERIFY_MODEL_DEFAULT,
): string {
	if (stored && options.some((o) => o.id === stored)) return stored;
	if (options.some((o) => o.id === fallback)) return fallback;
	return options[0]?.id ?? fallback;
}
