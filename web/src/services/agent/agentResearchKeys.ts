// SPDX-License-Identifier: AGPL-3.0-or-later
// Research-service keys (provider keys, hosted verify key): one settings row
// per worker keyName, stored with the Phase 5 rules (memory default,
// opt-in remember, Forget). No key name is hardcoded here; the panel passes
// the worker's agentSurface().keyNames straight through.
import {
	forgetAgentKey,
	getAgentKey,
	setAgentKey,
} from './agentKeyStore';

export interface ResearchKeyEntry {
	name: string;
}

export function loadResearchKeys(keyNames: string[]): ResearchKeyEntry[] {
	return keyNames.map((name) => ({ name }));
}

export function saveResearchKey(
	name: string,
	key: string,
	opts: { remember: boolean },
): void {
	setAgentKey(name, key, { remember: opts.remember });
}

export function forgetResearchKey(name: string): void {
	forgetAgentKey(name);
}

export function getResearchKey(name: string): string | undefined {
	return getAgentKey(name);
}

/** Env map for the worker's setEnv: only keys the researcher entered. */
export function buildResearchEnv(keyNames: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	for (const name of keyNames) {
		const key = getAgentKey(name);
		if (key) env[name] = key;
	}
	return env;
}
