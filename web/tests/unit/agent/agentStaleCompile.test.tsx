// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9d D1 (TDD-first): the agent compile stages the project as it is
// when the compile runs, never a tree captured when the agent was built.
//
// The render below holds a STALE file tree (mocked `useFileTree`, as the
// agent's `ensureAgent` closure would); a section file lands in the real
// store afterwards (as an agent `write` + view refresh would). The real
// `LaTeXProvider.compileForAgent` must stage that new file (engine boundary
// mocked, capturing the staged tree).
import { act, render } from '@testing-library/react';
import React, { useContext, useEffect, useRef } from 'react';

import { LaTeXContext, LaTeXProvider } from '@/contexts/LaTeXContext';
import type { LaTeXContextType } from '@/types/latex';
import { fileStoreService } from '@/services/FileStoreService';
import { latexService } from '@/services/LaTeXService';
import type { FileNode } from '@/types/files';

jest.mock('@/hooks/useFileTree', () => ({
	useFileTree: () => ({ fileTree: [] }),
}));

jest.mock('@/hooks/useSettings', () => ({
	useSettings: () => ({
		getSetting: (key: string) => {
			if (key === 'latex-engine') return { value: 'busytex-xetex' };
			if (key === 'latex-default-format') return { value: 'pdf' };
			if (key === 'latex-store-cache') return { value: true };
			if (key === 'latex-store-working-directory') return { value: false };
			return undefined;
		},
	}),
}));

const MAIN_PATH = '/manuscript/main.tex';
const SECTION_PATH = '/manuscript/sections/01-introduction.tex';

function node(id: string, path: string, name: string, content: string): FileNode {
	return { id, name, path, type: 'file', content, lastModified: Date.now(), size: content.length, mimeType: 'text/plain', isBinary: false };
}

describe('agent compile stages the store at call time (D1)', () => {
	let staged: FileNode[][] = [];
	let ctx: LaTeXContextType | null = null;

	function Probe() {
		const c = useContext(LaTeXContext);
		const did = useRef(false);
		useEffect(() => {
			if (did.current) return;
			did.current = true;
			ctx = c;
		}, [c]);
		return null;
	}

	beforeEach(async () => {
		staged = [];
		ctx = null;
		jest.spyOn(latexService, 'getCurrentEngineType').mockReturnValue('busytex-xetex' as never);
		jest.spyOn(latexService, 'isReady').mockReturnValue(true);
		jest.spyOn(latexService, 'compileLaTeX').mockImplementation(async (_entry: string, tree: FileNode[]) => {
			staged.push(tree);
			return { status: 0, log: 'ok', pdf: new Uint8Array([1, 2, 3]) };
		});
		await fileStoreService.initialize('yjs:test-d1-compile');
		await fileStoreService.storeFile(node('d1-main', MAIN_PATH, 'main.tex', '\\documentclass{article}\\begin{document}Hi.\\end{document}\n'));
		await act(async () => {
			render(
				<LaTeXProvider>
					<Probe />
				</LaTeXProvider>,
			);
		});
		if (!ctx) throw new Error('LaTeX context not captured');
	});

	afterEach(async () => {
		jest.restoreAllMocks();
		for (const f of await fileStoreService.getAllFiles(true, false, false)) {
			await fileStoreService.deleteFile(f.id, { showDeleteDialog: false }).catch(() => undefined);
		}
		fileStoreService.cleanup();
	});

	it('a section created after the render is staged by the agent compile', async () => {
		// The agent `write` of a new section lands in the store AFTER the
		// render that built the agent (stale `fileTree: []` above).
		await fileStoreService.storeFile(node('d1-sec', SECTION_PATH, '01-introduction.tex', 'A fresh sentence.\n'));
		let result: unknown;
		await act(async () => {
			result = await ctx?.compileForAgent('manuscript/main.tex');
		});
		expect((result as { status?: number })?.status).toBe(0);
		expect(staged.length).toBe(1);
		const paths = staged[0]?.map((n) => n.path) ?? [];
		expect(paths).toContain(SECTION_PATH);
	});
});
