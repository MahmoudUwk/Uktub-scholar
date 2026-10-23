// SPDX-License-Identifier: AGPL-3.0-or-later
// Page-wide compile mutex: the agent compile, the Compile button and export
// serialize (a second request waits); the turn always releases.
import { CompileMutex } from '../../../src/services/compileMutex';

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('compileMutex', () => {
	it('serializes agent/button/export in arrival order with no overlap', async () => {
		const mutex = new CompileMutex();
		const events: string[] = [];
		const holder = (name: string) => async () => {
			events.push(`${name}:start`);
			await tick();
			await tick();
			events.push(`${name}:end`);
		};
		await Promise.all([
			mutex.run(holder('agent')),
			mutex.run(holder('button')),
			mutex.run(holder('export')),
		]);
		expect(events).toEqual([
			'agent:start',
			'agent:end',
			'button:start',
			'button:end',
			'export:start',
			'export:end',
		]);
	});

	it('releases the turn when a holder throws', async () => {
		const mutex = new CompileMutex();
		const events: string[] = [];
		await expect(
			mutex.run(async () => {
				events.push('bad:start');
				throw new Error('engine blew up');
			}),
		).rejects.toThrow('engine blew up');
		await mutex.run(async () => {
			events.push('next:ran');
		});
		expect(events).toEqual(['bad:start', 'next:ran']);
	});

	it('skips a waiter whose signal aborts while waiting, then serves the next', async () => {
		const mutex = new CompileMutex();
		const events: string[] = [];
		let releaseFirst!: () => void;
		const first = mutex.run(
			() =>
				new Promise<string>((resolve) => {
					releaseFirst = () => resolve('first');
				}),
		);
		const ac = new AbortController();
		let secondRan = false;
		const second = mutex.run(
			async () => {
				secondRan = true;
				return 'second';
			},
			ac.signal,
		);
		const third = mutex.run(async () => {
			events.push('third:ran');
			return 'third';
		});
		ac.abort(new DOMException('The operation was aborted', 'AbortError'));
		await expect(second).rejects.toMatchObject({ name: 'AbortError' });
		expect(secondRan).toBe(false);
		releaseFirst();
		await expect(first).resolves.toBe('first');
		await expect(third).resolves.toBe('third');
		expect(events).toEqual(['third:ran']);
	});

	it('rejects without running when the signal is already aborted', async () => {
		const mutex = new CompileMutex();
		const ac = new AbortController();
		ac.abort();
		let ran = false;
		await expect(
			mutex.run(async () => {
				ran = true;
			}, ac.signal),
		).rejects.toBeTruthy();
		expect(ran).toBe(false);
	});

	it('an abort after start does not cancel the running holder', async () => {
		const mutex = new CompileMutex();
		const ac = new AbortController();
		let started = false;
		const running = mutex.run(async () => {
			started = true;
			await tick();
			return 'done';
		}, ac.signal);
		while (!started) await tick();
		ac.abort();
		await expect(running).resolves.toBe('done');
	});
});
