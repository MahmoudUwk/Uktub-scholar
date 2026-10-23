// SPDX-License-Identifier: AGPL-3.0-or-later
// Researcher API keys: memory-first, opt-in device persistence.
//
// - Keys live in a module-level Map (cleared on reload/restart).
// - "Remember on this device" (default OFF) mirrors the key into
//   localStorage on the app origin; "Forget" removes both copies.
// - Selection (provider/model) and per-provider test status are not
//   secrets and persist in localStorage; the key itself never does
//   unless the researcher opts in per provider.

import type { KeyTestStatus } from './classifyKeyTest';

const memoryKeys = new Map<string, string>();

const keySlot = (providerId: string): string => `uktub.agent.key.${providerId}`;
const statusSlot = (providerId: string): string => `uktub.agent.status.${providerId}`;
const SELECTION_SLOT = 'uktub.agent.selection';

export interface RememberOption {
	remember: boolean;
}

export interface AgentSelection {
	providerId: string;
	modelId: string;
}

function readStorage(key: string): string | null {
	try {
		return window.localStorage.getItem(key);
	} catch {
		return null;
	}
}

function writeStorage(key: string, value: string): void {
	try {
		window.localStorage.setItem(key, value);
	} catch {
		// Storage may be unavailable (private mode); memory still works.
	}
}

function removeStorage(key: string): void {
	try {
		window.localStorage.removeItem(key);
	} catch {
		// Ignore: nothing durable to clear.
	}
}

export function setAgentKey(providerId: string, key: string, opts: RememberOption): void {
	if (key) {
		memoryKeys.set(providerId, key);
	} else {
		memoryKeys.delete(providerId);
	}
	if (opts.remember && key) {
		writeStorage(keySlot(providerId), key);
	} else {
		removeStorage(keySlot(providerId));
	}
}

export function getAgentKey(providerId: string): string | undefined {
	const live = memoryKeys.get(providerId);
	if (live) return live;
	return readStorage(keySlot(providerId)) ?? undefined;
}

export function forgetAgentKey(providerId: string): void {
	memoryKeys.delete(providerId);
	removeStorage(keySlot(providerId));
}

export function saveAgentSelection(sel: AgentSelection): void {
	writeStorage(SELECTION_SLOT, JSON.stringify(sel));
}

export function loadAgentSelection(): AgentSelection | null {
	const raw = readStorage(SELECTION_SLOT);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<AgentSelection>;
		if (typeof parsed.providerId === 'string' && typeof parsed.modelId === 'string') {
			return { providerId: parsed.providerId, modelId: parsed.modelId };
		}
		return null;
	} catch {
		return null;
	}
}

export function saveKeyTestStatus(providerId: string, status: KeyTestStatus): void {
	writeStorage(statusSlot(providerId), status);
}

export function loadKeyTestStatus(providerId: string): KeyTestStatus | null {
	const raw = readStorage(statusSlot(providerId));
	return raw === 'ok' || raw === 'rejected' || raw === 'blocked' || raw === 'error' ? raw : null;
}

/** Test seam only: clears the in-memory map to simulate a reload. */
export function clearAgentKeysForTest(): void {
	memoryKeys.clear();
}

// Phase 9h: the three verification settings (engine, model-key opt-in,
// decision model) are NOT secrets, so unlike keys they persist the way the
// provider/model selection already persists: always in localStorage as JSON
// (memory-then-storage is for keys only). A separate slot keeps the three
// existing saveAgentSelection call sites untouched (no merge logic there);
// the panel restores these into state on mount, so a panel unmount/remount
// (sidebar view switch) keeps the researcher's settings and the mount-time
// setEnv push sends the current values instead of literal defaults.
const VERIFY_SELECTION_SLOT = 'uktub.agent.verify';

export interface VerifySelection {
	engine: string;
	useModelKey: boolean;
	model: string;
}

export function saveVerifySelection(sel: VerifySelection): void {
	writeStorage(VERIFY_SELECTION_SLOT, JSON.stringify(sel));
}

export function loadVerifySelection(): VerifySelection | null {
	const raw = readStorage(VERIFY_SELECTION_SLOT);
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw) as Partial<VerifySelection>;
		if (
			typeof parsed.engine === 'string' &&
			typeof parsed.useModelKey === 'boolean' &&
			typeof parsed.model === 'string'
		) {
			return { engine: parsed.engine, useModelKey: parsed.useModelKey, model: parsed.model };
		}
		return null;
	} catch {
		return null;
	}
}
