// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	clearAgentKeysForTest,
	forgetAgentKey,
	getAgentKey,
	setAgentKey,
} from '../../../src/services/agent/agentKeyStore';

const SLOT = 'uktub.agent.key.openrouter';

describe('agentKeyStore', () => {
	beforeEach(() => {
		clearAgentKeysForTest();
		window.localStorage.clear();
	});

	it('keeps a key in memory by default without touching localStorage', () => {
		setAgentKey('openrouter', 'sk-test-1', { remember: false });
		expect(getAgentKey('openrouter')).toBe('sk-test-1');
		expect(window.localStorage.getItem(SLOT)).toBeNull();
	});

	it('persists a remembered key to localStorage', () => {
		setAgentKey('openrouter', 'sk-test-2', { remember: true });
		expect(window.localStorage.getItem(SLOT)).toBe('sk-test-2');
	});

	it('unchecking remember removes a previously stored key', () => {
		setAgentKey('openrouter', 'sk-test-3', { remember: true });
		setAgentKey('openrouter', 'sk-test-3', { remember: false });
		expect(window.localStorage.getItem(SLOT)).toBeNull();
		expect(getAgentKey('openrouter')).toBe('sk-test-3');
	});

	it('forget removes the key from memory and storage', () => {
		setAgentKey('openrouter', 'sk-test-4', { remember: true });
		forgetAgentKey('openrouter');
		expect(getAgentKey('openrouter')).toBeUndefined();
		expect(window.localStorage.getItem(SLOT)).toBeNull();
	});

	it('reads a remembered key back after a memory wipe (reload)', () => {
		setAgentKey('openrouter', 'sk-test-5', { remember: true });
		clearAgentKeysForTest();
		expect(getAgentKey('openrouter')).toBe('sk-test-5');
	});

	it('an un-remembered key is gone after a memory wipe (reload)', () => {
		setAgentKey('openrouter', 'sk-test-6', { remember: false });
		clearAgentKeysForTest();
		expect(getAgentKey('openrouter')).toBeUndefined();
	});
});
