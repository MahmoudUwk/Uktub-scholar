// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9i: stable session ids for OpenRouter sticky routing, and per-turn
// usage accounting. No storage: ids live in a module map (one per project
// conversation), usage lives on the transcript entries of the session.
//
// Wiring (confirmed against the installed source):
// - pi-agent-core `Agent` takes a `sessionId` option (`agent.d.ts`) and
//   forwards it to every stream call via `createLoopConfig`
//   (`agent.js:311`). Our retry wrapper passes options through untouched.
// - pi-ai 1.4.0's openai-completions client sends it as `x-session-id`
//   when the model compat requests session affinity
//   (`dist/api/openai-completions.js:544-553`); for OpenRouter models the
//   compat sets exactly this header (`:1285-1306`), which OpenRouter
//   documents as the sticky-routing equivalent of the `session_id` body
//   field. pi-ai also keys the faux provider's prefix cache by it.
// - pi-agent-core `message_end` assistant messages carry
//   `usage {input, output, cacheRead, cacheWrite, cost{total}}`
//   (`EMPTY_USAGE`, `agent.js:10-17`).
//
// Parent and child use different ids: their static prefixes differ (parent
// ~4K tokens of tools+prompt, child ~1.1K of forwards+brief), so each
// multi-turn conversation pins its own affinity slot instead of sharing
// one. The child id derives from the parent's, so no new randomness is
// minted per turn and attribution stays unambiguous. Ids are a fixed
// prefix plus random hex: no keys, no personal data, far below
// OpenRouter's 256-char limit.

/** Per-turn usage as recorded from a `message_end` assistant message. */
export interface TurnUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

/** Child tally usage shape (`createChildTally` in root `src/agent/`). */
export interface ChildUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

const sessions = new Map<string, string>();

function randomHex(bytes: number): string {
	try {
		const buf = new Uint8Array(bytes);
		globalThis.crypto?.getRandomValues?.(buf);
		if (buf.some((b) => b !== 0)) {
			return [...buf].map((b) => b.toString(16).padStart(2, '0')).join('');
		}
	} catch {
		// Fall through to Math.random below.
	}
	let out = '';
	while (out.length < bytes * 2) {
		out += Math.floor(Math.random() * 0xffff).toString(16);
	}
	return out.slice(0, bytes * 2);
}

/**
 * The stable session id for one assistant conversation in one project.
 * Module-scoped, so sidebar remounts (which rebuild the agent) keep the
 * same id and the provider routing stays sticky.
 */
export function getOrCreateSessionId(scope: string): string {
	let id = sessions.get(scope);
	if (!id) {
		id = `uktub-${randomHex(16)}`;
		sessions.set(scope, id);
	}
	return id;
}

/** Test seam only: forget stored ids. */
export function clearSessionIdsForTest(): void {
	sessions.clear();
}

/**
 * The session id for one `write_section` child run, derived from the
 * parent's id plus the per-tool invocation sequence. Stable for the life
 * of that child run (all its turns share it), distinct across runs.
 */
export function deriveChildSessionId(parentId: string, seq: number): string {
	return `${parentId}:ws${seq}`;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/**
 * Pull the usage off a pi-agent-core message (a `message_end` payload).
 * Null unless this is an assistant message that actually reports usage.
 */
export function extractTurnUsage(message: unknown): TurnUsage | null {
	const m =
		typeof message === 'object' && message !== null
			? (message as { role?: unknown; usage?: unknown })
			: null;
	if (!m || m.role !== 'assistant') return null;
	const u =
		typeof m.usage === 'object' && m.usage !== null
			? (m.usage as Record<string, unknown> & { cost?: { total?: unknown } })
			: null;
	if (!u) return null;
	return {
		input: num(u.input),
		output: num(u.output),
		cacheRead: num(u.cacheRead),
		cacheWrite: num(u.cacheWrite),
		cost: num(u.cost?.total),
	};
}

function group(n: number): string {
	return Math.round(n)
		.toString()
		.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function trimCost(c: number): string {
	const s = c.toFixed(6).replace(/0+$/, '');
	return s.endsWith('.') ? s.slice(0, -1) : s;
}

/** Compact per-reply line, e.g. `tokens: 4,210 in (3,800 cached) · 312 out · $0.0004`. */
export function formatUsageLine(u: TurnUsage): string {
	const base = `tokens: ${group(u.input)} in (${group(u.cacheRead)} cached) · ${group(u.output)} out`;
	return u.cost > 0 ? `${base} · $${trimCost(u.cost)}` : base;
}

/** Sum per-turn usage into session totals (cost rounded to micros). */
export function sumUsage(list: TurnUsage[]): TurnUsage {
	const totals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	for (const u of list) {
		totals.input += u.input;
		totals.output += u.output;
		totals.cacheRead += u.cacheRead;
		totals.cacheWrite += u.cacheWrite;
		totals.cost += u.cost;
	}
	totals.cost = Math.round(totals.cost * 1_000_000) / 1_000_000;
	return totals;
}

/**
 * One-line child usage for the `write_section` tool row, e.g.
 * `child usage: 5,230 in (4,900 cached) · 410 out · $0.0008`.
 * Empty when the child reported nothing (providers may omit usage).
 */
export function formatChildUsageLine(u: ChildUsageTotals): string {
	if (
		!u ||
		(num(u.input) === 0 &&
			num(u.output) === 0 &&
			num(u.cacheRead) === 0 &&
			num(u.cacheWrite) === 0 &&
			num(u.costUsd) === 0)
	) {
		return '';
	}
	const base = `child usage: ${group(num(u.input))} in (${group(num(u.cacheRead))} cached) · ${group(num(u.output))} out`;
	return num(u.costUsd) > 0 ? `${base} · $${trimCost(num(u.costUsd))}` : base;
}
