// SPDX-License-Identifier: AGPL-3.0-or-later
// Browser pre-completion gate adapter (Phase 8a, Part B).
//
// Pi fires its gate at `agent_before_settle`; pi-agent-core has no such hook.
// The equivalent would-finish point here is `finishTurn` combined with the
// `followUp()` queue: `finishTurn` runs after the assistant turn and its tool
// results, before `turn_end`; a message queued with `followUp()` is polled by
// `getFollowUpMessages()` exactly when the loop would otherwise stop, and the
// SAME `prompt()` run continues with it (no `agent_end` in between).
// (pi-agent-core 1.3.0: `agent-loop.js` runs `finishTurn`, emits `turn_end`,
// then polls `getFollowUpMessages()` before `agent_end`; `agent.js` wires
// that poll to the follow-up queue drain.)
//
// The injected message is a plain `user`-role message carrying the worker's
// gate text byte-identical (Pi's `custom` gate entry is likewise converted to
// a user message for the LLM). The panel renders it as a distinct "Uktub
// check" transcript row via `addCheckMessage`, never as the researcher's
// words. Only pure-text completed turns are candidates: a turn carrying tool
// calls always continues to another provider request, and error/aborted
// turns are hard exits.
export interface GateTurnMessage {
	readonly content?: readonly { readonly type: string }[];
	readonly stopReason?: string;
}

export interface GateTurn {
	readonly message: GateTurnMessage;
}

export interface GateToolEvent {
	readonly toolName: string;
	readonly args: unknown;
	readonly isError: boolean;
}

export interface GateAdapterDeps {
	gateStartUserPrompt: () => void | Promise<void>;
	gateToolEnded: (event: GateToolEvent) => void | Promise<void>;
	gateSettle: () => { text: string | null } | Promise<{ text: string | null }>;
	addCheckMessage: (text: string) => void;
	followUp: (message: { role: 'user'; content: string; timestamp: number }) => void;
}

export interface GateAdapter {
	startUserPrompt(): Promise<void>;
	rememberToolStart(toolCallId: string, args: unknown): void;
	recordToolEnd(toolCallId: string, toolName: string, isError: boolean): Promise<void>;
	finishTurn(turn: GateTurn): Promise<{ action: 'continue' } | undefined>;
}

/** Pure adapter: no pi-agent-core runtime import (types only above), so unit tests load it without ESM. */
export function createGateAdapter(deps: GateAdapterDeps): GateAdapter {
	const pendingArgs = new Map<string, unknown>();
	return {
		async startUserPrompt(): Promise<void> {
			await deps.gateStartUserPrompt();
		},
		rememberToolStart(toolCallId: string, args: unknown): void {
			pendingArgs.set(toolCallId, args);
		},
		async recordToolEnd(toolCallId: string, toolName: string, isError: boolean): Promise<void> {
			const args = pendingArgs.get(toolCallId);
			pendingArgs.delete(toolCallId);
			await deps.gateToolEnded({ toolName, args, isError });
		},
		async finishTurn(turn: GateTurn): Promise<{ action: 'continue' } | undefined> {
			const message = turn.message;
			if (message.stopReason === 'error' || message.stopReason === 'aborted') return undefined;
			const content = message.content ?? [];
			if (content.some((block) => block.type === 'toolCall')) return undefined;
			let settled: { text: string | null };
			try {
				settled = await deps.gateSettle();
			} catch {
				return undefined; // fail open: the Tier 1 gate still catches it
			}
			const text = settled?.text;
			if (typeof text !== 'string' || text === '') return undefined;
			deps.addCheckMessage(text);
			deps.followUp({ role: 'user', content: text, timestamp: Date.now() });
			return undefined;
		},
	};
}
