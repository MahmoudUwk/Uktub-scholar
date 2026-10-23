// SPDX-License-Identifier: AGPL-3.0-or-later
// Project file tools (read/write/edit/ls): tool-owned refusals and Pi-style
// exact-match edit semantics against a fake project client.
import { buildFileTools } from '../../../src/services/agent/agentUktubTools';

interface Files {
	[path: string]: string;
}

function fakeClient(files: Files) {
	const written: Files = {};
	return {
		written,
		async readFile(rel: string) {
			if (!(rel in files)) throw new Error(`readFile: no such file (${rel})`);
			const text = files[rel] ?? '';
			return { path: rel, bytes: text.length, text };
		},
		async writeFile(rel: string, content: string) {
			written[rel] = content;
			files[rel] = content;
			return { path: rel, bytes: content.length };
		},
		async listFiles() {
			return {
				files: Object.keys(files).map((path) => ({ path, size: 0 })),
			};
		},
	};
}

async function run(tool: { execute: Function }, params: unknown) {
	return tool.execute('test-call', params, undefined, undefined);
}

describe('project file tools', () => {
	it('read returns the project file text', async () => {
		const client = fakeClient({ 'manuscript/main.tex': 'Hello.' });
		const tools = buildFileTools(client as never);
		const read = tools.find((t) => t.name === 'read')!;
		const out = await run(read as never, { path: 'manuscript/main.tex' });
		expect(out.isError).toBeFalsy();
		expect(out.content[0].text).toContain('Hello.');
	});

	it('read refuses tool-owned and escaping paths', async () => {
		const client = fakeClient({ 'manuscript/main.tex': 'Hello.' });
		const tools = buildFileTools(client as never);
		const read = tools.find((t) => t.name === 'read')!;
		for (const bad of ['refs/references.bib', '.registry/registry.db', '../evil.tex', '/abs.tex']) {
			const out = await run(read as never, { path: bad });
			expect(out.isError).toBe(true);
		}
	});

	it('write refuses refs/references.bib and .registry paths', async () => {
		const client = fakeClient({});
		const tools = buildFileTools(client as never);
		const write = tools.find((t) => t.name === 'write')!;
		const bib = await run(write as never, {
			path: 'refs/references.bib',
			content: '@article{x}',
		});
		expect(bib.isError).toBe(true);
		expect(bib.content[0].text).toMatch(/sync_bibliography/);
		const reg = await run(write as never, {
			path: '.registry/registry.db',
			content: 'x',
		});
		expect(reg.isError).toBe(true);
		const ok = await run(write as never, {
			path: 'manuscript/notes.tex',
			content: 'notes',
		});
		expect(ok.isError).toBeFalsy();
		expect(client.written['manuscript/notes.tex']).toBe('notes');
	});

	it('edit applies one exact match and rejects zero or multiple matches', async () => {
		const client = fakeClient({
			'manuscript/main.tex': 'alpha beta alpha\ngamma\n',
		});
		const tools = buildFileTools(client as never);
		const edit = tools.find((t) => t.name === 'edit')!;
		const zero = await run(edit as never, {
			path: 'manuscript/main.tex',
			edits: [{ oldText: 'delta', newText: 'D' }],
		});
		expect(zero.isError).toBe(true);
		expect(zero.content[0].text).toMatch(/Could not find/);
		const multi = await run(edit as never, {
			path: 'manuscript/main.tex',
			edits: [{ oldText: 'alpha', newText: 'A' }],
		});
		expect(multi.isError).toBe(true);
		expect(multi.content[0].text).toMatch(/unique/);
		const one = await run(edit as never, {
			path: 'manuscript/main.tex',
			edits: [{ oldText: 'beta', newText: 'BETA' }],
		});
		expect(one.isError).toBeFalsy();
		expect(client.written['manuscript/main.tex']).toBe(
			'alpha BETA alpha\ngamma\n',
		);
	});

	it('edit refuses tool-owned paths', async () => {
		const client = fakeClient({ 'refs/references.bib': '@article{x}' });
		const tools = buildFileTools(client as never);
		const edit = tools.find((t) => t.name === 'edit')!;
		const out = await run(edit as never, {
			path: 'refs/references.bib',
			edits: [{ oldText: 'x', newText: 'y' }],
		});
		expect(out.isError).toBe(true);
	});

	it('ls marks directories with a trailing slash', async () => {
		const client = fakeClient({
			'manuscript/main.tex': 'x',
			'manuscript/sections/a.tex': 'y',
		});
		const tools = buildFileTools(client as never);
		const ls = tools.find((t) => t.name === 'ls')!;
		const out = await run(ls as never, { path: 'manuscript' });
		expect(out.isError).toBeFalsy();
		const text = out.content[0].text as string;
		expect(text).toMatch(/main\.tex/);
		expect(text).toMatch(/sections\//);
	});
});
