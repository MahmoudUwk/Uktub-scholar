// SPDX-License-Identifier: AGPL-3.0-or-later
import {
	isUktubProtectedPath,
	isUktubToolOwned,
	parentDirsOf,
	toStorePath,
	toUktubRel,
	UKTUB_BIB,
	UKTUB_MAIN_TEX,
	UKTUB_MAIN_TEX_TEMPLATE,
} from '../../src/services/uktubPaths';

describe('uktubPaths', () => {
	it('converts between store paths and /proj rels', () => {
		expect(toUktubRel('/manuscript/main.tex')).toBe('manuscript/main.tex');
		expect(toUktubRel('manuscript/main.tex')).toBe('manuscript/main.tex');
		expect(toStorePath('manuscript/main.tex')).toBe('/manuscript/main.tex');
		expect(toStorePath('/manuscript/main.tex')).toBe('/manuscript/main.tex');
	});

	it('names tool-owned paths', () => {
		expect(isUktubToolOwned('/refs/references.bib')).toBe(true);
		expect(isUktubToolOwned('refs/references.bib')).toBe(true);
		expect(isUktubToolOwned('/.registry/registry.db')).toBe(true);
		expect(isUktubToolOwned('/manuscript/main.tex')).toBe(false);
		expect(isUktubToolOwned('/refs/notes.tex')).toBe(false);
	});

	it('protects tool-owned paths and their ancestors', () => {
		expect(isUktubProtectedPath('/refs/references.bib')).toBe(true);
		expect(isUktubProtectedPath('/refs')).toBe(true);
		expect(isUktubProtectedPath('/')).toBe(true);
		expect(isUktubProtectedPath('/manuscript/main.tex')).toBe(false);
		expect(isUktubProtectedPath('/results')).toBe(false);
	});

	it('lists implied parent dirs', () => {
		expect(parentDirsOf('/manuscript/sections/intro.tex')).toEqual([
			'/manuscript',
			'/manuscript/sections',
		]);
	});

	it('ships a minimal XeLaTeX layout template', () => {
		expect(UKTUB_MAIN_TEX).toBe('manuscript/main.tex');
		expect(UKTUB_BIB).toBe('refs/references.bib');
		expect(UKTUB_MAIN_TEX_TEMPLATE).toContain('\\documentclass');
		expect(UKTUB_MAIN_TEX_TEMPLATE).toContain(
			'\\bibliography{../refs/references}',
		);
	});
});
