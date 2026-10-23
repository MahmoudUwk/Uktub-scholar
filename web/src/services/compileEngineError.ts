// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser engine-missing error (Phase 7): thrown page-side when BusyTeX
// itself cannot load. The wording is browser-only on purpose — it must
// never mention the Node CLI (`uktub-scholar tectonic install`), which the
// core COMPILE_ENGINE_MISSING hint names. Kept dependency-free so both the
// (eager) LaTeX context and the (lazy) agent chunk share it.
export class EngineMissingError extends Error {
	readonly next: string;
	constructor(message: string, next: string) {
		super(message);
		this.name = 'EngineMissingError';
		this.next = next;
	}
}

/** Browser `next` hint for a BusyTeX load failure (no Node CLI wording). */
export const ENGINE_MISSING_NEXT =
	'wait for the TeX bundle to finish downloading (or reload the project) and retry; ' +
	'if the Compile button also fails, check the network connection — the bundle downloads from this app';

/** Browser message for a BusyTeX load failure (no Node CLI wording). */
export function engineMissingMessage(reason: string): string {
	return (
		`the browser TeX engine (BusyTeX) failed to load (${reason}); ` +
		'the Compile button needs the same engine'
	);
}
