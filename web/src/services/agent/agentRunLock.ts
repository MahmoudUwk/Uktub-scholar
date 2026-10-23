// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent run lock: while an agent run is active, open editors are read-only
// (reuse of the tool-owned read-only mechanism) so a user edit cannot be
// lost mid-run; after a writing tool runs, the changed files are announced
// so the editor and tree can show the agent's change.
import { useSyncExternalStore } from 'react';

let runActive = false;
const runListeners = new Set<() => void>();

function emitRun(): void {
	for (const notify of [...runListeners]) {
		try {
			notify();
		} catch {
			// A stale listener must not break the lock.
		}
	}
}

export function setAgentRunActive(active: boolean): void {
	if (runActive === active) return;
	runActive = active;
	emitRun();
}

export function isAgentRunActive(): boolean {
	return runActive;
}

function subscribeAgentRun(notify: () => void): () => void {
	runListeners.add(notify);
	return () => {
		runListeners.delete(notify);
	};
}

export function useAgentRunActive(): boolean {
	return useSyncExternalStore(subscribeAgentRun, isAgentRunActive);
}

export interface AgentFilesChanged {
	/** Project-relative paths (`manuscript/main.tex`) refreshed from `/proj`. */
	rels: string[];
}

const filesListeners = new Set<(event: AgentFilesChanged) => void>();

/** Announce files the agent changed (store + `/proj` already updated). */
export function emitAgentFilesChanged(rels: string[]): void {
	if (rels.length === 0) return;
	const event = { rels: [...rels] };
	for (const notify of [...filesListeners]) {
		try {
			notify(event);
		} catch {
			// A stale listener must not break the refresh.
		}
	}
}

export function subscribeAgentFilesChanged(
	notify: (event: AgentFilesChanged) => void,
): () => void {
	filesListeners.add(notify);
	return () => {
		filesListeners.delete(notify);
	};
}
