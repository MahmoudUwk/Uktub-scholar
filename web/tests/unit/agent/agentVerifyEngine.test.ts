// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9g requirement tests (RED first): the verification-model choice is
// dynamic from pi-ai's catalog, and selecting the paid model pushes
// UKTUB_OPENROUTER_MODEL alongside the existing engine/key env.
import fs from 'node:fs';
import path from 'node:path';

import { createModels } from '@earendil-works/pi-ai';

import {
	VERIFY_ENGINE_DEFAULT,
	VERIFY_MODEL_DEFAULT,
	buildVerifyEnv,
	formatVerifyModelPrice,
	listVerifyModels,
	resolveVerifyModel,
} from '../../../src/services/agent/agentVerifyEngine';

describe('phase 9g verification model (real pi-ai 1.4.0 catalog)', () => {
	// The real OpenRouter slice of pi-ai 1.4.0's catalog: the exact
	// openrouter.json data file the catalog is generated from (its
	// `typesafe-system-one` group holds the classifier entries, marked
	// type `classifier` / api `typesafe-system-one`), read back through
	// a real Models collection's getModelsOfType (the same accessor the
	// browser picker uses). Only the provider registration is a shim:
	// providers/all pulls ESM-only lazy modules Jest cannot require.
	const realOpenRouterCatalog = () => {
		const dataPath = path.join(
			__dirname,
			'../../../node_modules/@earendil-works/pi-ai/dist/providers/data/openrouter.json',
		);
		const values = JSON.parse(fs.readFileSync(dataPath, 'utf8')) as Record<string, Record<string, unknown>>;
		const classifiers = Object.values(values['typesafe-system-one'] ?? {});
		const models = createModels();
		models.setProvider({
			id: 'openrouter',
			name: 'OpenRouter',
			auth: { apiKey: { name: 'OpenRouter API key' } },
			getModels: () => [],
			getAllModels: () => classifiers,
		} as never);
		return models;
	};

	it('lists both mercury-decide variants from the OpenRouter classifier catalog', () => {
		const models = listVerifyModels(realOpenRouterCatalog());
		const ids = models.map((m) => m.id);
		expect(ids).toContain('inception/mercury-decide:free');
		expect(ids).toContain('inception/mercury-decide');
	});

	it('selects the core default, with the catalog price for each variant', () => {
		const models = listVerifyModels(realOpenRouterCatalog());
		expect(resolveVerifyModel(undefined, models)).toBe(VERIFY_MODEL_DEFAULT);
		expect(VERIFY_MODEL_DEFAULT).toBe('inception/mercury-decide:free');
		const byId = new Map(models.map((m) => [m.id, m]));
		expect(byId.get('inception/mercury-decide:free')!.priceLabel).toBe('free');
		expect(byId.get('inception/mercury-decide')!.priceLabel).toMatch(/\$0\.02.*input/);
		expect(byId.get('inception/mercury-decide')!.free).toBe(false);
	});

	it('formats a literal cost without a catalog', () => {
		expect(formatVerifyModelPrice({ input: 0, output: 0 })).toBe('free');
		expect(formatVerifyModelPrice({ input: 0.02, output: 0 })).toBe('$0.02/M input');
		expect(formatVerifyModelPrice({ input: 10, output: 50 })).toBe('$10/M input');
	});
});

describe('phase 9g verify env push', () => {
	it('pushes the paid model together with the engine and both key names (no key dropped)', () => {
		expect(
			buildVerifyEnv({
				engine: VERIFY_ENGINE_DEFAULT,
				openRouterKey: 'k',
				verifyModel: 'inception/mercury-decide',
			}),
		).toEqual({
			UKTUB_VERIFY_ENGINE: 'openrouter',
			OPENROUTER_API_KEY: 'k',
			UKTUB_OPENROUTER_API_KEY: 'k',
			UKTUB_OPENROUTER_MODEL: 'inception/mercury-decide',
		});
	});
});
