// SPDX-License-Identifier: AGPL-3.0-or-later
// Research-service key settings derive from the worker's keyNames: no key
// name is hardcoded in web; storage follows the Phase 5 rules.
import {
	buildResearchEnv,
	forgetResearchKey,
	loadResearchKeys,
	saveResearchKey,
} from '../../../src/services/agent/agentResearchKeys';
import { getAgentKey } from '../../../src/services/agent/agentKeyStore';

const KEY_NAMES = ['UKTUB_VERIFY_API_KEY', 'SEMANTIC_SCHOLAR_API_KEY'];

describe('research-service key settings', () => {
	it('lists exactly the worker keyNames, nothing hardcoded', () => {
		expect(loadResearchKeys(KEY_NAMES).map((e) => e.name)).toEqual(KEY_NAMES);
		expect(loadResearchKeys([])).toEqual([]);
	});

	it('saves and forgets through the shared key store, and builds the env map', () => {
		saveResearchKey('SEMANTIC_SCHOLAR_API_KEY', 's2-key', { remember: false });
		expect(getAgentKey('SEMANTIC_SCHOLAR_API_KEY')).toBe('s2-key');
		expect(buildResearchEnv(KEY_NAMES)).toEqual({
			SEMANTIC_SCHOLAR_API_KEY: 's2-key',
		});
		forgetResearchKey('SEMANTIC_SCHOLAR_API_KEY');
		expect(getAgentKey('SEMANTIC_SCHOLAR_API_KEY')).toBeUndefined();
		expect(buildResearchEnv(KEY_NAMES)).toEqual({});
	});
});
