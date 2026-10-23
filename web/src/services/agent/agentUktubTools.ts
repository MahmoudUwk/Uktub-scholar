// SPDX-License-Identifier: AGPL-3.0-or-later
// Agent tools for the web panel: Uktub research tools (built from the
// worker's agentSurface, pi-agent-core AgentTools) plus project file tools
// (read/write/edit/ls, named and shaped like Pi's built-in file tools).
//
// Pi built-in reference (@earendil-works/pi-coding-agent 1.3.0,
// dist/core/tools/*.js): parameter names, property descriptions and tool
// descriptions below mirror read.js, write.js, edit.js and ls.js; only the
// operations differ (project client instead of the local filesystem, no
// shell, tool-owned paths refused). Edit keeps Pi's exact-match semantics:
// zero or multiple matches without replace_all is an error.
import { Type } from '@earendil-works/pi-ai';
import type { JsonValue } from '@earendil-works/pi-ai';
import type { AgentTool } from '@earendil-works/pi-agent-core';

import {
	isUktubToolOwned,
	UKTUB_BIB,
} from '../uktubPaths';

/** MCP-style core tool result, as returned by the worker's `callTool`. */
export interface CoreToolResult {
	content: { type: 'text'; text: string }[];
	structuredContent: JsonValue | null;
	details: Record<string, unknown>;
}

/** pi-agent-core result shape for the panel transcript and the model. */
export interface PanelToolResult {
	content: { type: 'text'; text: string }[];
	details: unknown;
	structuredContent?: JsonValue;
	isError?: boolean;
}

/**
 * Map a core result (MCP-style content text, structuredContent, isError) to
 * a pi-agent-core result. Refusals (`details.refused`) and thrown worker
 * envelopes (`details.thrown`) become `isError: true` so the model sees the
 * failure; success keeps its structured content.
 */
export function toAgentToolResult(result: CoreToolResult): PanelToolResult {
	const details = result.details ?? {};
	const isError =
		(details as { refused?: unknown }).refused !== undefined ||
		(details as { thrown?: unknown }).thrown === true;
	const out: PanelToolResult = { content: result.content, details };
	if (result.structuredContent !== null && result.structuredContent !== undefined) {
		out.structuredContent = result.structuredContent;
	}
	if (isError) out.isError = true;
	return out;
}

/** Minimal project surface the file tools need (the real client satisfies this). */
export interface ProjectFileClient {
	readFile(
		rel: string,
		encoding?: 'utf8' | 'base64',
	): Promise<{ path: string; bytes: number; text?: string; base64?: string }>;
	writeFile(
		rel: string,
		content: string | Uint8Array,
	): Promise<{ path: string; bytes: number }>;
	listFiles(): Promise<{ files: { path: string; size: number }[] }>;
	callTool(
		name: string,
		args: Record<string, unknown>,
		opts?: { signal?: AbortSignal },
	): Promise<CoreToolResult>;
}

function toolError(text: string): PanelToolResult {
	return {
		content: [{ type: 'text', text }],
		details: { toolRefusal: text },
		isError: true,
	};
}

function toolText(text: string): PanelToolResult {
	return { content: [{ type: 'text', text }], details: undefined };
}

/** Project-relative, no escapes, no absolute paths (the worker refuses these too). */
function cleanRel(path: string): string | null {
	if (typeof path !== 'string' || path.trim() === '' || path.includes('\0')) return null;
	if (path.startsWith('/')) return null;
	const segs = path.split(/[\\/]/);
	if (segs.includes('..') || segs.includes('')) return null;
	return segs.join('/');
}

function refuseWriteReason(rel: string): string | null {
	if (rel === UKTUB_BIB) {
		return `refused: ${UKTUB_BIB} is tool-owned (use the registry tool's sync_bibliography action)`;
	}
	if (isUktubToolOwned(rel) || rel === '.git' || rel.startsWith('.git/')) {
		return `refused: ${rel} is tool-owned or protected`;
	}
	return null;
}

function countOccurrences(haystack: string, needle: string): number {
	if (needle === '') return 0;
	let count = 0;
	let from = 0;
	for (;;) {
		const idx = haystack.indexOf(needle, from);
		if (idx === -1) return count;
		count++;
		from = idx + needle.length;
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new Error('Operation aborted');
}

const MAX_READ_LINES = 2000;

function sliceLines(text: string, offset?: number, limit?: number): { text: string; truncated: boolean } {
	const lines = text.split('\n');
	const start = offset !== undefined ? Math.max(0, Math.floor(offset) - 1) : 0;
	if (start >= lines.length) {
		throw new Error(
			`Offset ${offset} is beyond end of file (${lines.length} lines total)`,
		);
	}
	const max = limit !== undefined ? Math.max(0, Math.floor(limit)) : lines.length - start;
	const end = Math.min(lines.length, start + Math.min(max, MAX_READ_LINES));
	const truncated = end < start + max || lines.length - start > MAX_READ_LINES;
	return { text: lines.slice(start, end).join('\n'), truncated };
}

function normalizeEdits(input: unknown): { oldText: string; newText: string }[] | null {
	if (Array.isArray(input)) return input as { oldText: string; newText: string }[];
	if (input !== null && typeof input === 'object') {
		const single = input as { oldText?: unknown; newText?: unknown };
		if (typeof single.oldText === 'string' && typeof single.newText === 'string') {
			return [{ oldText: single.oldText, newText: single.newText }];
		}
	}
	return null;
}

/**
 * Project file tools, named and shaped like Pi's built-in `read`, `write`,
 * `edit` and `ls` (parameter schemas and descriptions mirror pi-coding-agent
 * 1.3.0), operating on the project via the client. Paths are
 * project-relative; tool-owned paths are refused for `write`/`edit`.
 *
 * Phase 9d D2: `hooks.afterWrite` runs inside `write`/`edit` before they
 * return, so the FileStore view refresh completes before any parallel
 * tool call's flush can reconcile the just-written file away.
 */
export function buildFileTools(
	client: ProjectFileClient,
	hooks?: {
		/** Refresh the view for a just-written file; must never throw. */
		afterWrite?: (rel: string) => Promise<void>;
	},
): AgentTool[] {
	const read: AgentTool = {
		name: 'read',
		label: 'read',
		description:
			'Read the contents of a project file. For text files, output is truncated to 2000 lines ' +
			'(whichever is hit first). Use offset/limit for large files. When you need the full file, ' +
			'continue with offset until complete. Paths are project-relative.',
		parameters: Type.Object({
			path: Type.String({ description: 'Path to the file to read, project-relative' }),
			offset: Type.Optional(Type.Number({ description: 'Line number to start reading from (1-indexed)' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum number of lines to read' })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const { path, offset, limit } = params as {
				path: unknown;
				offset?: unknown;
				limit?: unknown;
			};
			const rel = typeof path === 'string' ? cleanRel(path) : null;
			if (rel === null) return toolError(`refused: invalid project path (${String(path)})`);
			if (isUktubToolOwned(rel) && rel !== UKTUB_BIB) {
				return toolError(`refused: ${rel} is tool-owned`);
			}
			let text: string;
			try {
				const res = await client.readFile(rel);
				text = res.text ?? '';
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			throwIfAborted(signal);
			try {
				const { text: sliced, truncated } = sliceLines(
					text,
					typeof offset === 'number' ? offset : undefined,
					typeof limit === 'number' ? limit : undefined,
				);
				return toolText(truncated ? `${sliced}\n\n[2000 lines limit reached]` : sliced);
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
		},
	};

	const write: AgentTool = {
		name: 'write',
		label: 'write',
		description:
			"Write content to a project file. Creates the file if it doesn't exist, overwrites if it does. " +
			'Paths are project-relative. Tool-owned paths (refs/references.bib, .registry/) are refused.',
		parameters: Type.Object({
			path: Type.String({ description: 'Path to the file to write, project-relative' }),
			content: Type.String({ description: 'Content to write to the file' }),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const { path, content } = params as { path: unknown; content: unknown };
			const rel = typeof path === 'string' ? cleanRel(path) : null;
			if (rel === null) return toolError(`refused: invalid project path (${String(path)})`);
			const refusal = refuseWriteReason(rel);
			if (refusal) return toolError(refusal);
			if (typeof content !== 'string') return toolError('write requires a string content');
			throwIfAborted(signal);
			try {
				await client.writeFile(rel, content);
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			throwIfAborted(signal);
			// Phase 9d D2: the view refresh completes inside this execute, so
			// a parallel compile's flush sees the file in the view.
			await hooks?.afterWrite?.(rel);
			return toolText(`Successfully wrote to ${rel}.`);
			},
			};

			const edit: AgentTool = {
		name: 'edit',
		label: 'edit',
		description:
			'Edit a single project file using exact text replacement. Every edits[].oldText must match a ' +
			'unique, non-overlapping region of the file. If two changes affect the same block or nearby ' +
			'lines, merge them into one edit instead of emitting overlapping edits. Do not include large ' +
			'unchanged regions just to connect distant changes. Tool-owned paths are refused.',
		parameters: Type.Object({
			path: Type.String({ description: 'Path to the file to edit, project-relative' }),
			edits: Type.Array(
				Type.Object({
					oldText: Type.String({
						description:
							'Exact text for one targeted replacement. It must be unique in the file and must not overlap with any other edits[].oldText in the same call.',
					}),
					newText: Type.String({ description: 'Replacement text for this targeted edit.' }),
				}),
				{
					description:
						'One or more targeted replacements. Each edit is matched in order; do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.',
				},
			),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const { path, edits } = params as { path: unknown; edits: unknown };
			const rel = typeof path === 'string' ? cleanRel(path) : null;
			if (rel === null) return toolError(`refused: invalid project path (${String(path)})`);
			const refusal = refuseWriteReason(rel);
			if (refusal) return toolError(refusal);
			const list = normalizeEdits(edits);
			if (!list || list.length === 0) return toolError('edit requires a non-empty edits array');
			let current: string;
			try {
				current = (await client.readFile(rel)).text ?? '';
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			let count = 0;
			for (const [i, e] of list.entries()) {
				throwIfAborted(signal);
				if (typeof e.oldText !== 'string' || typeof e.newText !== 'string') {
					return toolError(`edit ${i}: oldText and newText must be strings`);
				}
				if (e.oldText === '') {
					return toolError(`edit ${i}: oldText must not be empty`);
				}
				const found = countOccurrences(current, e.oldText);
				if (found === 0) {
					return toolError(
						`Could not find the exact text in ${rel}. The old text must match exactly including all whitespace and newlines.`,
					);
				}
				if (found > 1) {
					return toolError(
						`Found ${found} occurrences of the text in ${rel}. The text must be unique. Please provide more context to make it unique.`,
					);
				}
				current = current.replace(e.oldText, () => e.newText);
				count++;
			}
			throwIfAborted(signal);
			try {
				await client.writeFile(rel, current);
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			// Phase 9d D2: the view refresh completes inside this execute, so
			// a parallel compile's flush sees the file in the view.
			await hooks?.afterWrite?.(rel);
			return toolText(`Successfully replaced ${count} block(s) in ${rel}.`);
		},
	};

	const ls: AgentTool = {
		name: 'ls',
		label: 'ls',
		description:
			"List project directory contents. Returns entries sorted alphabetically, with '/' suffix for " +
			'directories. Output is truncated to 500 entries (use limit for more). Paths are project-relative.',
		parameters: Type.Object({
			path: Type.Optional(Type.String({ description: 'Directory to list (default: project root)' })),
			limit: Type.Optional(Type.Number({ description: 'Maximum number of entries to return (default: 500)' })),
		}),
		async execute(_toolCallId, params, signal) {
			throwIfAborted(signal);
			const { path, limit } = params as { path?: unknown; limit?: unknown };
			const raw = path === undefined ? '' : typeof path === 'string' ? cleanRel(path) : null;
			if (raw === null) return toolError(`refused: invalid project path (${String(path)})`);
			const prefix = raw === '' ? '' : `${raw}/`;
			let files: { path: string; size: number }[];
			try {
				files = (await client.listFiles()).files;
			} catch (err) {
				return toolError(err instanceof Error ? err.message : String(err));
			}
			throwIfAborted(signal);
			const inScope = files
				.map((f) => f.path)
				.filter((p) => p.startsWith(prefix) && p !== raw);
			const children = new Map<string, boolean>();
			for (const p of inScope) {
				const rest = p.slice(prefix.length);
				const slash = rest.indexOf('/');
				if (slash === -1) children.set(rest, false);
				else children.set(rest.slice(0, slash), true);
			}
			const entries = [...children.entries()]
				.map(([name, isDir]) => (isDir ? `${name}/` : name))
				.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
			const effectiveLimit =
				typeof limit === 'number' && Number.isFinite(limit) && limit >= 0
					? Math.floor(limit)
					: 500;
			const shown = entries.slice(0, effectiveLimit);
			if (shown.length === 0) return toolText('(empty directory)');
		 const extra =
				entries.length > effectiveLimit
					? `\n\n[${effectiveLimit} entries limit reached. Use limit=${effectiveLimit * 2} for more]`
					: '';
			return toolText(shown.join('\n') + extra);
		},
	};

	return [read, write, edit, ls];
}

/** One surface entry, as served by the worker's `agentSurface`. */
export interface SurfaceTool {
	name: string;
	description: string;
	inputSchema: unknown;
}

/**
 * Build pi-agent-core tools from the worker's agentSurface: `parameters` is
 * the shared core input schema (`Type.Unsafe`), `execute` calls
 * `client.callTool` with the abort signal wired to the client's
 * cancellation, and the core result maps through `toAgentToolResult`.
 *
 * The `compile` tool is the exception: the engine lives in this page
 * (BusyTeX), so when `opts.compile` is provided the worker half
 * (`compilePrepare`/`compileFinish`) brackets the page run instead of a
 * plain `callTool` (which would refuse `COMPILE_ENGINE_MISSING` — there is
 * no Tectonic in the browser).
 */
export function buildUktubAgentTools(
	client: ProjectFileClient,
	surfaceTools: SurfaceTool[],
	opts?: {
		compile?: {
			execute: (
				args: Record<string, unknown>,
				signal?: AbortSignal,
			) => Promise<PanelToolResult>;
		};
		/**
		 * Phase 9d D2: refresh the view for worker-side writes (the `registry`
		 * tool renders the bibliography and stages new files). Runs inside
		 * the `registry` execute before it returns; must never throw.
		 */
		afterRegistry?: () => Promise<void>;
	},
): AgentTool[] {
	return surfaceTools.map(
		(t): AgentTool => {
			const hook = t.name === 'compile' ? opts?.compile : undefined;
			return {
				name: t.name,
				label: t.name,
				description: t.description,
				parameters: Type.Unsafe(t.inputSchema as Record<string, unknown>),
				async execute(_toolCallId, params, signal) {
					if (hook) return hook.execute((params ?? {}) as Record<string, unknown>, signal);
					try {
						const result = await client.callTool(
							t.name,
							(params ?? {}) as Record<string, unknown>,
							{ signal },
						);
						const mapped = toAgentToolResult(result);
						if (t.name === 'registry' && !mapped.isError) {
							await opts?.afterRegistry?.();
						}
						return mapped;
					} catch (err) {
					if (signal?.aborted || (err instanceof Error && /abort/i.test(err.message))) {
						throw err;
					}
					const message = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: 'text', text: `tool ${t.name} failed: ${message}` }],
						details: { thrown: true, tool: t.name, message },
						isError: true,
					};
				}
				},
			};
		},
	);
}
