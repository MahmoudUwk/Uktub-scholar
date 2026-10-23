// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9i requirement tests (TDD-first): stable session ids and per-turn
// usage accounting helpers in `src/services/agent/agentSession`.
import {
	deriveChildSessionId,
	extractTurnUsage,
	formatChildUsageLine,
	formatUsageLine,
	getOrCreateSessionId,
	sumUsage,
} from '../../../src/services/agent/agentSession';

describe('phase 9i session ids', () => {
	it('is stable per project scope and distinct across projects', () => {
		const a1 = getOrCreateSessionId('proj-a');
		const a2 = getOrCreateSessionId('proj-a');
		const b = getOrCreateSessionId('proj-b');
		expect(typeof a1).toBe('string');
		expect(a1.length).toBeGreaterThan(0);
		expect(a1).toBe(a2);
		expect(b).not.toBe(a1);
	});

	it('carries no key material: fixed prefix plus random chars, within the OpenRouter limit', () => {
		const id = getOrCreateSessionId('proj-charset');
		expect(id.length).toBeLessThanOrEqual(256);
		expect(id).toMatch(/^[A-Za-z0-9:_-]+$/);
		expect(id.startsWith('uktub-')).toBe(true);
	});

	it('derives a stable per-child id from the parent id', () => {
		const parent = getOrCreateSessionId('proj-child');
		const c1 = deriveChildSessionId(parent, 1);
		expect(c1).toBe(deriveChildSessionId(parent, 1));
		expect(c1.startsWith(parent)).toBe(true);
		expect(deriveChildSessionId(parent, 2)).not.toBe(c1);
		expect(c1.length).toBeLessThanOrEqual(256);
	});
});

describe('phase 9i usage helpers', () => {
	it('extracts pi-agent-core message_end usage and ignores non-assistant messages', () => {
		const usage = extractTurnUsage({
			role: 'assistant',
			usage: { input: 4210, output: 312, cacheRead: 3800, cacheWrite: 0, cost: { total: 0.0004 } },
		});
		expect(usage).toEqual({ input: 4210, output: 312, cacheRead: 3800, cacheWrite: 0, cost: 0.0004 });
		expect(extractTurnUsage({ role: 'assistant' })).toBeNull();
		expect(
			extractTurnUsage({ role: 'tool', usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } }),
		).toBeNull();
	});

	it('formats the compact per-reply usage line', () => {
		expect(
			formatUsageLine({ input: 4210, output: 312, cacheRead: 3800, cacheWrite: 0, cost: 0.0004 }),
		).toBe('tokens: 4,210 in (3,800 cached) · 312 out · $0.0004');
		// No cost shown when the provider reports none.
		expect(formatUsageLine({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: 0 })).toBe(
			'tokens: 100 in (0 cached) · 20 out',
		);
	});

	it('sums per-turn usage into totals', () => {
		expect(
			sumUsage([
				{ input: 100, output: 20, cacheRead: 10, cacheWrite: 0, cost: 0.001 },
				{ input: 200, output: 30, cacheRead: 150, cacheWrite: 0, cost: 0.002 },
			]),
		).toEqual({ input: 300, output: 50, cacheRead: 160, cacheWrite: 0, cost: 0.003 });
	});

	it('formats the child usage line for the write_section row, empty when nothing was reported', () => {
		const line = formatChildUsageLine({ input: 1234, output: 89, cacheRead: 567, cacheWrite: 0, costUsd: 0.0012 });
		expect(line).toContain('1,234');
		expect(line).toContain('567');
		expect(line).toContain('89');
		expect(
			formatChildUsageLine({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 }),
		).toBe('');
	});
});
