// Pure helpers for the Uktub `/proj` (OPFS) ownership bridge.
//
// TeXlyre's FileStoreService paths are absolute UI paths with a leading `/`
// (e.g. `/manuscript/main.tex`); the Uktub worker addresses the same files
// relative to `/proj` (e.g. `manuscript/main.tex`). These helpers convert
// between the two and name the tool-owned paths the UI must not write.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/** Uktub project layout owned by `/proj` (fixed for UI-created projects). */
export const UKTUB_MAIN_TEX = 'manuscript/main.tex';
export const UKTUB_SECTIONS_DIR = 'manuscript/sections';
export const UKTUB_RESULTS_DIR = 'results';
export const UKTUB_BIB = 'refs/references.bib';

/** Minimal XeLaTeX article with no prose (prose here would be an unlabelled statement in every new project); `\input`s nothing; bibliography is tool-owned. */
export const UKTUB_MAIN_TEX_TEMPLATE = `% Uktub Scholar manuscript (XeLaTeX). Compiled with BusyTeX.
% refs/references.bib is generated from the registry; do not edit it by hand.
\\documentclass[11pt]{article}
\\usepackage{fontspec}
\\usepackage{hyperref}

\\title{Untitled}
\\author{}

\\begin{document}
\\maketitle

% Write each section in its own file, manuscript/sections/NN-name.tex, and \\input it here,
% e.g. \\input{sections/01-introduction}. Prose here is checked before the assistant finishes.

\\bibliographystyle{plain}
\\bibliography{../refs/references}
\\end{document}
`;

/** `true` when the path is tool-owned (UI shows it read-only, never writes). */
export function isUktubToolOwned(storePathOrRel: string): boolean {
	const rel = toUktubRel(storePathOrRel);
	return rel === UKTUB_BIB || rel === '.registry' || rel.startsWith('.registry/');
}

/** `/manuscript/main.tex` -> `manuscript/main.tex` (also passes rels through). */
export function toUktubRel(storePath: string): string {
	return storePath.replace(/^\/+/, '');
}

/** Note shown in the editor for tool-owned files. */
export const UKTUB_TOOL_OWNED_NOTE =
	'This file is generated from the registry and is read-only here.';

/**
 * `true` when the path itself is tool-owned or is an ancestor directory of a
 * tool-owned file (`/`, `/refs`): deleting/moving/renaming it would corrupt
 * tool-owned state, so the UI refuses those operations.
 */
export function isUktubProtectedPath(storePathOrRel: string): boolean {
	const rel = toUktubRel(storePathOrRel);
	if (rel === '') return true;
	if (isUktubToolOwned(rel)) return true;
	return UKTUB_BIB.startsWith(`${rel}/`);
}

/** `manuscript/main.tex` -> `/manuscript/main.tex`. */
export function toStorePath(rel: string): string {
	return `/${rel.replace(/^\/+/, '')}`;
}

/** Parent dir records (leading `/`) implied by a stored file path. */
export function parentDirsOf(storePath: string): string[] {
	const parts = toUktubRel(storePath).split('/');
	const dirs: string[] = [];
	for (let i = 1; i < parts.length; i++) {
		dirs.push(`/${parts.slice(0, i).join('/')}`);
	}
	return dirs;
}
