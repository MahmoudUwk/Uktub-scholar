// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent `compile` execute mapping: prepare -> flush -> run -> finish, with
// timeout/stop/missing-engine behavior. Deps are faked; the worker contract
// itself is covered by tests-browser/compile.spec.ts.
import {
	BUSYTEX_ENGINE_LABEL,
	EngineMissingError,
	executeAgentCompile,
	type AgentCompileDeps,
} from '../../../src/services/agent/agentCompile';

function fakeDeps(over: Partial<AgentCompileDeps> = {}): AgentCompileDeps & {
	calls: { prepare: unknown[]; flush: number; run: unknown[]; stop: number; finish: unknown[] };
} {
	const calls = { prepare: [] as unknown[], flush: 0, run: [] as unknown[], stop: 0, finish: [] as unknown[] };
	return {
		calls,
		ops: {
			prepare: async (entry?: string) => {
				calls.prepare.push(entry);
				return { ok: true, rel: 'manuscript/main.tex' };
			},
			finish: async (args) => {
				calls.finish.push(args);
				return {
					content: [{ type: 'text', text: 'Compiled manuscript/main.tex' }],
					structuredContent: { status: 'compiled', engine: 'busytex 1.4.1' },
					details: {},
				};
			},
		},
		flush: async () => {
			calls.flush += 1;
		},
		run: async (rel: string) => {
			calls.run.push(rel);
			return { status: 0, log: 'fake log', pdf: new Uint8Array([1, 2, 3]) };
		},
		stop: () => {
			calls.stop += 1;
		},
		timeoutMs: 120000,
		engineLabel: BUSYTEX_ENGINE_LABEL,
		...over,
	};
}

describe('executeAgentCompile', () => {
	it('maps a successful run through the worker finish unchanged', async () => {
		const deps = fakeDeps();
		const out = await executeAgentCompile({}, { deps });
		expect(deps.calls.prepare).toEqual([undefined]);
		expect(deps.calls.flush).toBe(1);
		expect(deps.calls.run).toEqual(['manuscript/main.tex']);
		expect(deps.calls.finish).toEqual([
			{
				entry: 'manuscript/main.tex',
				engineLabel: BUSYTEX_ENGINE_LABEL,
				code: 0,
				timedOut: false,
				log: 'fake log',
				pdf: new Uint8Array([1, 2, 3]),
			},
		]);
		expect(out.isError).toBeFalsy();
		expect(out.structuredContent).toEqual({ status: 'compiled', engine: 'busytex 1.4.1' });
	});

	it('a prepare refusal is an error and never reaches the engine', async () => {
		const deps = fakeDeps({
			ops: {
				prepare: async () => ({ ok: false, code: 'COMPILE_NO_ENTRY', message: 'no .tex entry found' }),
				finish: async () => {
					throw new Error('must not finish');
				},
			},
		});
		const out = await executeAgentCompile({ entry: 'missing.tex' }, { deps });
		expect(out.isError).toBe(true);
		expect(out.structuredContent).toBeNull();
		expect(out.content[0]?.text).toMatch(/COMPILE_NO_ENTRY/);
		expect(deps.calls.run).toEqual([]);
	});

	it('a missing engine refuses without Node CLI wording', async () => {
		const deps = fakeDeps({
			run: async () => {
				throw new EngineMissingError(
					'the browser TeX engine (BusyTeX) failed to load (bundle fetch failed)',
					'wait for the TeX bundle to finish downloading and retry',
				);
			},
		});
		const out = await executeAgentCompile({}, { deps });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toMatch(/COMPILE_ENGINE_MISSING/);
		expect(out.content[0]?.text).not.toMatch(/tectonic install/);
		expect(out.content[0]?.text).not.toMatch(/UKTUB_TECTONIC_BIN/);
	});

	it('a timeout stops the engine and reports the worker timeout refusal', async () => {
		const finishArgs: unknown[] = [];
		const deps = fakeDeps({
			timeoutMs: 20,
			run: () => new Promise(() => {}),
			ops: {
				prepare: async () => ({ ok: true, rel: 'manuscript/main.tex' }),
				finish: async (args) => {
					finishArgs.push(args);
					return {
						content: [{ type: 'text', text: 'Refused: COMPILE_TIMEOUT — busytex exceeded the 120s budget.' }],
						structuredContent: null,
						details: { refused: { code: 'COMPILE_TIMEOUT', message: 'busytex exceeded the 120s budget' } },
					};
				},
			},
		});
		const out = await executeAgentCompile({}, { deps });
		expect(deps.calls.stop).toBe(1);
		expect(finishArgs).toEqual([
			{ entry: 'manuscript/main.tex', engineLabel: BUSYTEX_ENGINE_LABEL, code: 1, timedOut: true, log: '' },
		]);
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toMatch(/COMPILE_TIMEOUT/);
	});

	it('an agent Stop during the run throws abort-flavored (a stopped row, not an error)', async () => {
		const ac = new AbortController();
		const deps = fakeDeps({
			run: (_rel, signal) =>
				new Promise<never>((_, reject) => {
					// The page run rejects when the agent stops (after stopping the engine).
					signal?.addEventListener(
						'abort',
						() =>
							reject(
								signal.reason ??
									new DOMException('The operation was aborted', 'AbortError'),
							),
						{ once: true },
					);
					ac.abort(new DOMException('The operation was aborted', 'AbortError'));
				}),
		});
		await expect(executeAgentCompile({}, { signal: ac.signal, deps })).rejects.toMatchObject({
			name: 'AbortError',
		});
	});

	it('an unexpected engine throw is an error row, never a crash', async () => {
		const deps = fakeDeps({
			run: async () => {
				throw new Error('worker exploded');
			},
		});
		const out = await executeAgentCompile({}, { deps });
		expect(out.isError).toBe(true);
		expect(out.content[0]?.text).toMatch(/tool compile failed: worker exploded/);
	});

	it('the engine label tracks the installed texlyre-busytex version', async () => {
		// eslint-disable-next-line @typescript-eslint/no-require-imports
		const pkg = require('texlyre-busytex/package.json') as { version: string };
		expect(BUSYTEX_ENGINE_LABEL).toBe(`busytex ${pkg.version}`);
	});
});
