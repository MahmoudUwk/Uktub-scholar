// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent `compile` execute (Phase 7): prepare -> flush -> page compile under
// the page-wide mutex -> worker finish. Maps to the same tool-result shape
// the Node/Tectonic tool returns (via toAgentToolResult).
import { renderRefusal } from '../../../../src/core/refusals.ts';
import { BROWSER_REFUSAL_NEXT } from '../../../../src/browser/refusal-next.ts';

import {
	toAgentToolResult,
	type CoreToolResult,
	type PanelToolResult,
} from './agentUktubTools';

/**
 * Engine label reported in the tool result (`busytex <bundle>`).
 * `texlyre-busytex` version (web/node_modules/texlyre-busytex/package.json);
 * Jest-pinned so a bundle bump renames the label instead of lying.
 */
export const BUSYTEX_ENGINE_LABEL = 'busytex 1.4.1';

/** Thrown page-side when BusyTeX itself cannot load (never a Node refusal). */
export class EngineMissingError extends Error {
	readonly next: string;
	constructor(message: string, next: string) {
		super(message);
		this.name = 'EngineMissingError';
		this.next = next;
	}
}

/** Worker half of the agent compile (entry resolution + engine-neutral finish). */
export interface CompileWorkerOps {
	prepare(
		entry?: string,
	): Promise<
		{ ok: true; rel: string } | { ok: false; code: string; message: string }
	>;
	finish(args: {
		entry: string;
		engineLabel: string;
		code: number;
		timedOut: boolean;
		log: string;
		pdf?: Uint8Array | null;
	}): Promise<CoreToolResult>;
}

/** Page half of the agent compile, injected so Jest covers the mapping. */
export interface AgentCompileDeps {
	ops: CompileWorkerOps;
	/** Flush open editor buffers into the project (Phase 4 write-back). */
	flush(): Promise<void>;
	/**
	 * Run the SAME compile the Compile button runs (BusyTeX, default
	 * XeLaTeX) under the page-wide mutex with viewer/log updates; reject on
	 * agent Stop (after stopping the engine) or engine failure.
	 */
	run(
		entryRel: string,
		signal?: AbortSignal,
	): Promise<{ status: number; log: string; pdf?: Uint8Array }>;
	/** Stop the in-flight engine run (timeout or agent Stop). */
	stop(): void;
	/** Core compile budget through the agent surface — never a copied number. */
	timeoutMs: number;
	engineLabel: string;
}

function abortError(signal?: AbortSignal): unknown {
	return (
		signal?.reason ??
		new DOMException('The operation was aborted', 'AbortError')
	);
}

/**
 * Execute the agent `compile` tool. Returns the core result (compiled/errors
 * with diagnostics, refusals as `isError`); throws only when the run itself
 * was stopped, so the panel row shows `stopped` instead of `error`.
 */
export async function executeAgentCompile(
	args: { entry?: string },
	opts: { signal?: AbortSignal; deps: AgentCompileDeps },
): Promise<PanelToolResult> {
	const { signal, deps } = opts;
	const throwIfStopped = (): void => {
		if (signal?.aborted) throw abortError(signal);
	};

	// 1. Entry: the core resolution, same refusals as Node.
	const prep = await deps.ops.prepare(args.entry);
	throwIfStopped();
	if (!prep.ok) {
		const text = renderRefusal(
			{
				code: prep.code as 'COMPILE_NO_ENTRY',
				message: prep.message,
			},
			BROWSER_REFUSAL_NEXT,
		);
		return {
			content: [{ type: 'text', text }],
			structuredContent: null,
			details: { refused: { code: prep.code, message: prep.message } },
			isError: true,
		};
	}

	// 2. Flush editor buffers (beforeToolCall already flushed; idempotent).
	await deps.flush();
	throwIfStopped();

	// 3-4. Run under the page mutex with the core timeout.
	let timedOut = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		const runP = deps.run(prep.rel, signal);
		const timeoutP = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				timedOut = true;
				deps.stop();
				reject(new Error('compile timeout'));
			}, deps.timeoutMs);
		});
		let run: { status: number; log: string; pdf?: Uint8Array };
		try {
			run = await Promise.race([runP, timeoutP]);
		} catch (err) {
			if (timedOut) {
				// Like Node: the budget refusal carries the timeout text.
				const res = await deps.ops.finish({
					entry: prep.rel,
					engineLabel: deps.engineLabel,
					code: 1,
					timedOut: true,
					log: '',
				});
				return toAgentToolResult(res);
			}
			throw err;
		} finally {
			if (timer !== undefined) clearTimeout(timer);
		}
		throwIfStopped();
		const res = await deps.ops.finish({
			entry: prep.rel,
			engineLabel: deps.engineLabel,
			code: run.status,
			timedOut: false,
			log: run.log,
			...(run.pdf !== undefined ? { pdf: run.pdf } : {}),
		});
		return toAgentToolResult(res);
	} catch (err) {
		if (err instanceof EngineMissingError) {
			const text = `Refused: COMPILE_ENGINE_MISSING — ${err.message}. Next: ${err.next}.`;
			return {
				content: [{ type: 'text', text }],
				structuredContent: null,
				details: {
					refused: { code: 'COMPILE_ENGINE_MISSING', message: err.message },
				},
				isError: true,
			};
		}
		// Agent Stop (or an abort-flavored engine failure) is a cancellation,
		// never an error row — mirrors the generic tool mapping.
		if (
			signal?.aborted ||
			(err instanceof Error && /abort/i.test(err.message))
		) {
			throw err;
		}
		const message = err instanceof Error ? err.message : String(err);
		return {
			content: [{ type: 'text', text: `tool compile failed: ${message}` }],
			structuredContent: null,
			details: { thrown: true, tool: 'compile', message },
			isError: true,
		};
	}
}
