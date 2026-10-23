// SPDX-License-Identifier: AGPL-3.0-or-later
// Research assistant panel: model picker (pi-ai catalog), per-provider key
// entry with a one-shot key test, research-service keys (from the worker's
// agentSurface), and chat on pi-agent-core with Uktub tools.
//
// - One Agent per open project: this panel remounts per project (keyed by
//   docUrl in the parent) and the transcript lives in memory only.
// - Provider keys live in agentKeyStore (memory-first, opt-in localStorage).
//   Research-service keys use the same store (keyed by env var name); every
//   change is pushed to the worker via setEnv. No key is ever rendered,
//   logged or stored elsewhere.
// - System prompt is the worker's agentSurface().rules plus the bundled
//   document-writing workflow section (Pi appends the same section last).
// - Tools: the worker's agentSurface().tools (parameters via Type.Unsafe,
//   execute via client.callTool with abort wired to cancellation) plus
//   project file tools (read/write/edit/ls) operating on the project via
//   the client. No bash.
// - Before every tool call the panel flushes open editor buffers into the
//   project (Phase 4 write-back); after a writing tool (write/edit/registry)
//   it refreshes the view from /proj. While a run is active, open editors
//   are read-only (run lock) so a user edit cannot be lost mid-run.
import { useEffect, useMemo, useRef, useState } from 'react';

import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentEvent, AgentTool } from '@earendil-works/pi-agent-core';
import type { Model, Models } from '@earendil-works/pi-ai';

import { t } from '@/i18n';

import {
	buildAgentCatalogView,
	countCatalogModels,
	type AgentModelView,
	type AgentProviderView,
} from '../../services/agent/agentCatalog';
import type { KeyTestStatus } from '../../services/agent/classifyKeyTest';
import {
	forgetAgentKey,
	getAgentKey,
	loadAgentSelection,
	loadKeyTestStatus,
	loadVerifySelection,
	saveAgentSelection,
	saveKeyTestStatus,
	saveVerifySelection,
	setAgentKey,
} from '../../services/agent/agentKeyStore';
import { getAgentModels } from '../../services/agent/agentModels';
import { setAgentRunActive } from '../../services/agent/agentRunLock';
import {
	buildResearchEnv,
	forgetResearchKey,
	getResearchKey,
	saveResearchKey,
} from '../../services/agent/agentResearchKeys';
import {
	buildFileTools,
	buildUktubAgentTools,
	type CoreToolResult,
	type SurfaceTool,
} from '../../services/agent/agentUktubTools';
import {
	buildWriteSectionTool,
	writeSectionChildSummary,
} from '../../services/agent/agentWriteSection';
import {
	buildVerifyEnv,
	listVerifyModels,
	resolveOpenRouterKey,
	resolveVerifyEngine,
	resolveVerifyModel,
	OPENROUTER_KEY_ENV,
	VERIFY_ENGINE_DEFAULT,
	VERIFY_MODEL_DEFAULT,
	type VerifyModelOption,
} from '../../services/agent/agentVerifyEngine';
import { createGateAdapter, type GateAdapter } from '../../services/agent/agentCompletionGate';
import { withAgentRetry, type AgentRetryInfo } from '../../services/agent/agentRetry';
import {
	extractTurnUsage,
	formatUsageLine,
	getOrCreateSessionId,
	sumUsage,
	type TurnUsage,
} from '../../services/agent/agentSession';
import {
	BUSYTEX_ENGINE_LABEL,
	executeAgentCompile,
} from '../../services/agent/agentCompile';
import { useLaTeX } from '../../hooks/useLaTeX';
import { runKeyTest } from '../../services/agent/runKeyTest';
import { fileStoreService } from '../../services/FileStoreService';
import { uktubProjectService } from '../../services/UktubProjectService';
import {
	isUktubToolOwned,
	toUktubRel,
	UKTUB_BIB,
} from '../../services/uktubPaths';

const ERROR_BOUND = 200;
const MODEL_DROPDOWN_CAP = 12;
const TOOL_PREVIEW_CHARS = 300;

interface TranscriptEntry {
	id: number;
	role: 'user' | 'assistant' | 'error' | 'check' | 'retry';
	text: string;
	/** Phase 9i: per-turn usage from the `message_end` event (session only, never stored). */
	usage?: TurnUsage;
}

interface ToolRow {
	id: string;
	toolCallId: string;
	name: string;
	argsSummary: string;
	fullArgs: unknown;
	status: 'running' | 'ok' | 'error' | 'stopped';
	preview: string;
}

interface AgentPanelProps {
	docUrl: string;
}

function formatCost(m: AgentModelView): string {
	if (m.free) return 'free';
	const fmt = (n: number): string =>
		Number.isInteger(n) ? String(n) : n.toFixed(2);
	return `$${fmt(m.costInput)}/$${fmt(m.costOutput)} per M`;
}

function formatCtx(n: number): string {
	if (n >= 1000000)
		return `${(n / 1000000).toFixed(n % 1000000 === 0 ? 0 : 1)}M`;
	if (n >= 1000) return `${Math.round(n / 1000)}k`;
	return String(n);
}

/** Short args summary for a tool row (bounded; tool args carry no secrets). */
function summarizeArgs(args: unknown): string {
	let text: string;
	try {
		text = JSON.stringify(args) ?? '';
	} catch {
		text = String(args);
	}
	if (text.length > 160) return `${text.slice(0, 160)}…`;
	return text;
}

function previewResult(result: { content?: unknown }): string {
	const blocks =
		(result as { content?: { type?: string; text?: string }[] }).content ?? [];
	const text = blocks
		.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
		.map((b) => b.text as string)
		.join('\n');
	const lines = text.split('\n').slice(0, 3).join('\n');
	return lines.length > TOOL_PREVIEW_CHARS
		? `${lines.slice(0, TOOL_PREVIEW_CHARS)}…`
		: lines;
}

const AgentPanel: React.FC<AgentPanelProps> = ({ docUrl }) => {
	const [catalog, setCatalog] = useState<AgentProviderView[] | null>(null);
	const [catalogError, setCatalogError] = useState<string | null>(null);
	const [providerId, setProviderId] = useState<string>('');
	const [modelId, setModelId] = useState<string>('');
	const [modelFilter, setModelFilter] = useState('');
	const [modelOpen, setModelOpen] = useState(false);
	const [keyDraft, setKeyDraft] = useState('');
	const [remember, setRemember] = useState(false);
	const [keyStatus, setKeyStatus] = useState<KeyTestStatus | null>(null);
	const [keyDetail, setKeyDetail] = useState('');
	const [testing, setTesting] = useState(false);
	const [settingsCollapsed, setSettingsCollapsed] = useState(false);
	const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
	const [toolRows, setToolRows] = useState<ToolRow[]>([]);
	const [input, setInput] = useState('');
	const [busy, setBusy] = useState(false);
	const [surfaceError, setSurfaceError] = useState<string | null>(null);
	const [surfaceTools, setSurfaceTools] = useState<SurfaceTool[]>([]);
	const [surfaceRules, setSurfaceRules] = useState<string[]>([]);
	const [surfaceWorkflow, setSurfaceWorkflow] = useState<string | null>(null);
	const [compileTimeoutMs, setCompileTimeoutMs] = useState<number | null>(null);
	const [researchKeys, setResearchKeys] = useState<string[]>([]);
	const [researchTick, setResearchTick] = useState(0);
	// Phase 8b: verification engine (worker-derived list, default openrouter) and
	// the opt-in OpenRouter key source (default off: separate key field).
	// Phase 9g: verification decision model (pi-ai classifier catalog,
	// default the core openrouter default), pushed as UKTUB_OPENROUTER_MODEL.
	// Phase 9h: all three restore the researcher's stored choice on mount
	// (sidebar view switches unmount/remount this panel, which would
	// otherwise forget them and drop the key on the next mount-time push).
	const [verificationEngines, setVerificationEngines] = useState<string[]>([]);
	const [verifyEngine, setVerifyEngine] = useState<string>(
		() => loadVerifySelection()?.engine ?? VERIFY_ENGINE_DEFAULT,
	);
	const [verifyUseModelKey, setVerifyUseModelKey] = useState(
		() => loadVerifySelection()?.useModelKey ?? false,
	);
	const [verifyModelOptions, setVerifyModelOptions] = useState<VerifyModelOption[]>([]);
	const [verifyModel, setVerifyModel] = useState<string>(
		() => loadVerifySelection()?.model ?? VERIFY_MODEL_DEFAULT,
	);

	const agentRef = useRef<Agent | null>(null);
	const gateAdapterRef = useRef<GateAdapter | null>(null);
	const modelsRef = useRef<Models | null>(null);
	const toolRowsRef = useRef<ToolRow[]>([]);
	toolRowsRef.current = toolRows;
	const unsubRef = useRef<(() => void) | null>(null);
	const idRef = useRef(1);
	const testAbortRef = useRef<AbortController | null>(null);
	const busyRef = useRef(false);
	busyRef.current = busy;
	const { compileForAgent, stopCompilation } = useLaTeX();

	const provider = useMemo(
		() => catalog?.find((p) => p.id === providerId) ?? null,
		[catalog, providerId],
	);

	const filteredModels = useMemo(() => {
		const q = modelFilter.trim().toLowerCase();
		const all = provider?.models ?? [];
		if (!q) return all;
		return all.filter(
			(m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q),
		);
	}, [provider, modelFilter]);

	const selectedModel = useMemo(
		() => provider?.models.find((m) => m.id === modelId) ?? null,
		[provider, modelId],
	);

	// Phase 9f visible fallback: a stored `hosted` choice from an older
	// session renders as the first offered engine, never as an
	// unreachable selection; pushes use it too.
	const effectiveVerifyEngine = resolveVerifyEngine(
		verifyEngine,
		verificationEngines.length > 0 ? verificationEngines : [VERIFY_ENGINE_DEFAULT],
	);

	// Phase 9g visible fallback: a stored model the catalog no longer lists
	// falls back to the core default; pushes use this too.
	const effectiveVerifyModel = resolveVerifyModel(
		verifyModel,
		verifyModelOptions.length > 0 ? verifyModelOptions : [],
	);

	// Load the catalog once (lazy chunk: pi-ai is imported here only).
	useEffect(() => {
		let cancelled = false;
		getAgentModels()
			.then((models) => {
				if (cancelled) return;
				modelsRef.current = models;
				const view = buildAgentCatalogView(models);
				setCatalog(view);
				setVerifyModelOptions(listVerifyModels(models));
				const saved = loadAgentSelection();
				const savedProvider =
					saved && view.find((p) => p.id === saved.providerId);
				const firstProvider =
					savedProvider ??
					view.find((p) => p.id === 'openrouter') ??
					view.find((p) => !p.signInOnly) ??
					view[0];
				if (!firstProvider) {
					setCatalogError('The model catalog is empty.');
					return;
				}
				const savedModel =
					savedProvider &&
					saved?.modelId &&
					savedProvider.models.some((m) => m.id === saved.modelId)
						? saved.modelId
						: (firstProvider.models[0]?.id ?? '');
				setProviderId(firstProvider.id);
				setModelId(savedModel);
				setKeyStatus(loadKeyTestStatus(firstProvider.id));
				setKeyDetail('');
			})
			.catch((err: unknown) => {
				if (!cancelled) {
					setCatalogError(
						err instanceof Error
							? err.message.slice(0, ERROR_BOUND)
							: String(err),
					);
				}
			});
		return () => {
			cancelled = true;
		};
	}, []);

	// Teardown: stop any in-flight turn and the key test on unmount.
	useEffect(
		() => () => {
			unsubRef.current?.();
			agentRef.current?.abort();
			setAgentRunActive(false);
			testAbortRef.current?.abort();
		},
		[docUrl],
	);

	// Phase 8a: the system prompt is the worker's rules plus the bundled
	// document-writing workflow (Pi appends the same section last, after its
	// rules, so the workflow rides last here too).
	const systemPromptText = (() => {
		const rules =
			surfaceRules.length > 0
				? surfaceRules
				: ['You are the research writing assistant in Uktub Scholar.'];
		return surfaceWorkflow ? `${rules.join('\n')}\n\n${surfaceWorkflow}` : rules.join('\n');
	})();

	// Diagnostics seam for acceptance (no secrets: counts, ids, statuses only).
	// Phase 9a: only in builds with VITE_UKTUB_ACCEPTANCE_SEAMS=1; the
	// production bundle drops this branch.
	useEffect(() => {
		if (import.meta.env.VITE_UKTUB_ACCEPTANCE_SEAMS === '1') {
			(window as unknown as { __uktubAgent?: unknown }).__uktubAgent = {
			providerCount: catalog?.length ?? 0,
			modelCount: catalog ? countCatalogModels(catalog) : 0,
			providerId,
			modelId,
			busy,
			keyStatus,
			transcriptLength: transcript.length,
			transcriptTail: transcript
				.slice(-3)
				.map((e) => ({ role: e.role, chars: e.text.length })),
			// Phase 9i: per-turn usage plus session totals (session only,
			// never stored; the harness reads this, never the model text).
			usage: (() => {
				const turns = transcript
					.filter((e) => e.usage !== undefined)
					.map((e) => ({ ...(e.usage as TurnUsage) }));
				const totals = sumUsage(turns);
				return {
					turns,
					totals,
					cachedShare: totals.input > 0 ? totals.cacheRead / totals.input : 0,
				};
			})(),
			verifyModel: effectiveVerifyModel,
			verifyModelCount: verifyModelOptions.length,
			surfaceToolCount: surfaceTools.length,
			toolRowCount: toolRows.length,
			toolNames:
				agentRef.current !== null
					? (agentRef.current.state.tools as { name?: unknown }[]).map((t) => t.name)
					: [],
			// Phase 9d model-free check: drive the agent's own tool
			// `execute` path directly (no model, no key). Used only by
			// the acceptance script, never by the UI.
			runTool: async (name: string, args: Record<string, unknown>) => {
				const agent = ensureAgent();
				if (!agent) return { ok: false as const, error: 'agent not ready' };
				const tool = (agent.state.tools as AgentTool[]).find((t) => t.name === name);
				if (!tool) return { ok: false as const, error: `no such agent tool: ${name}` };
				try {
					const out = await tool.execute(`seam-${idRef.current++}`, args, undefined);
					const blocks = (out as { content?: { type?: unknown; text?: unknown }[] }).content ?? [];
					const text = blocks
						.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
						.map((b) => b.text as string)
						.join('\n');
					const isError = (out as { isError?: unknown }).isError === true;
					return { ok: true as const, isError, text: text.slice(0, 4000) };
				} catch (err) {
					return {
						ok: false as const,
						error: err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
					};
				}
			},
			systemPromptChars: systemPromptText.length,
			systemPromptHasWorkflow: systemPromptText.includes('## Writing a document from the papers'),
			};
		}
	});

	function selectProvider(id: string): void {
		const next = catalog?.find((p) => p.id === id);
		if (!next) return;
		setProviderId(id);
		setModelId(next.models[0]?.id ?? '');
		setModelFilter('');
		setModelOpen(false);
		setKeyDraft('');
		setKeyStatus(loadKeyTestStatus(id));
		setKeyDetail('');
		setSettingsCollapsed(false);
		saveAgentSelection({ providerId: id, modelId: next.models[0]?.id ?? '' });
	}

	function selectModel(id: string): void {
		setModelId(id);
		setModelOpen(false);
		setModelFilter('');
		setSettingsCollapsed(false);
		saveAgentSelection({ providerId, modelId: id });
	}

	async function testKey(key: string): Promise<void> {
		const models = await getAgentModels();
		const live = models.getModel(providerId, modelId) as
			| Model<string>
			| undefined;
		if (!live) {
			setKeyStatus('error');
			setKeyDetail('Select a model first.');
			return;
		}
		testAbortRef.current?.abort();
		const ctrl = new AbortController();
		testAbortRef.current = ctrl;
		setTesting(true);
		setKeyDetail('');
		try {
			const out = await runKeyTest(models, live, key, ctrl.signal);
			setKeyStatus(out.status);
			setKeyDetail(out.detail);
			saveKeyTestStatus(providerId, out.status);
			if (out.status === 'ok') setSettingsCollapsed(true);
		} finally {
			if (testAbortRef.current === ctrl) {
				testAbortRef.current = null;
				setTesting(false);
			}
		}
	}

	async function handleTest(): Promise<void> {
		const key = keyDraft || getAgentKey(providerId) || '';
		if (!key) {
			setKeyStatus('error');
			setKeyDetail('Enter a key first.');
			return;
		}
		await testKey(key);
	}

	async function handleSave(): Promise<void> {
		const key = keyDraft || getAgentKey(providerId) || '';
		if (!key) {
			setKeyStatus('error');
			setKeyDetail('Enter a key first.');
			return;
		}
		// Persist the selection; the key itself only when the researcher opts in.
		setAgentKey(providerId, key, { remember });
		saveAgentSelection({ providerId, modelId });
		await testKey(key);
		// The model key may feed the verification engine (opt-in checkbox).
		await pushEnv(researchKeys, effectiveVerifyEngine, verifyUseModelKey, effectiveVerifyModel);
	}

	function handleForget(): void {
		forgetAgentKey(providerId);
		setKeyDraft('');
		setRemember(false);
		setKeyStatus(null);
		setKeyDetail('');
		setSettingsCollapsed(false);
		try {
			window.localStorage.removeItem(`uktub.agent.status.${providerId}`);
		} catch {
			// Ignore: status is best-effort durable state.
		}
	}

	function appendToAssistant(delta: string): void {
		setTranscript((prev) => {
			if (prev.length === 0 || prev[prev.length - 1].role !== 'assistant')
				return prev;
			const next = [...prev];
			next[next.length - 1] = {
				...next[next.length - 1],
				text: next[next.length - 1].text + delta,
			};
			return next;
		});
	}

	/**
	 * Phase 9d D3: one visible transcript row per auto-retry, matching the
	 * required shape ("rate limited — retrying in Ns, attempt k/n", headed
	 * by the provider error's own head). Stop aborts the pending wait
	 * through the run signal, so this row is always followed by progress.
	 */
	function addRetryRow(info: AgentRetryInfo, toolName?: string): void {
		const head = info.errorMessage.split('\n')[0]?.slice(0, 120) ?? 'The provider returned an error';
		const secs = info.delayMs < 1000 ? `${info.delayMs}ms` : `${info.delayMs / 1000}s`;
		const prefix = toolName !== undefined ? `${toolName}: ` : '';
		const id = idRef.current++;
		const text = `${prefix}${head} — retrying in ${secs}, attempt ${info.attempt}/${info.maxAttempts}.`;
		setTranscript((prev) => [...prev, { id, role: 'retry', text }]);
	}

	function addToolRow(toolCallId: string, name: string, args: unknown): void {
		setToolRows((prev) => {
			if (prev.some((r) => r.toolCallId === toolCallId)) return prev;
			return [
				...prev,
				{
					id: `tool-${idRef.current++}`,
					toolCallId,
					name,
					argsSummary: summarizeArgs(args),
					fullArgs: args,
					status: 'running' as const,
					preview: '',
				},
			];
		});
	}

	function patchToolRow(
		toolCallId: string,
		patch: Pick<ToolRow, 'status' | 'preview'>,
	): void {
		setToolRows((prev) =>
			prev.map((r) => (r.toolCallId === toolCallId ? { ...r, ...patch } : r)),
		);
	}

	/** Refresh the FileStore view after a writing tool ran. Never throws. */
	async function refreshAfterTool(name: string, args: unknown): Promise<void> {
		try {
			if (name === 'compile') {
				const pdfPath =
					args !== null && typeof args === 'object'
						? (args as { pdfPath?: unknown }).pdfPath
						: undefined;
				if (typeof pdfPath === 'string' && pdfPath !== '') {
					await uktubProjectService.refreshAgentPaths([pdfPath]);
				}
				return;
			}
			if (name === 'write' || name === 'edit') {
				const path =
					args !== null && typeof args === 'object'
						? (args as { path?: unknown }).path
						: undefined;
				if (typeof path === 'string' && path !== '') {
					await uktubProjectService.refreshAgentPaths([path]);
				}
				return;
			}
			if (name === 'registry') {
				// The bib is re-rendered tool-side; staged sources add new files.
				const client = uktubProjectService.getClient();
				if (!client) return;
				const { files } = await client.listFiles();
				const known = new Set(
					(await fileStoreService.getAllFiles(true, false, false)).map((f) =>
						toUktubRel(f.path),
					),
				);
				const missing = files
					.map((f) => f.path)
					.filter((p) => !known.has(toUktubRel(p)) && !isUktubToolOwned(p));
				await uktubProjectService.refreshAgentPaths([UKTUB_BIB, ...missing]);
			}
		} catch (error) {
			const id = idRef.current++;
			setTranscript((prev) => [
				...prev,
				{
					id,
					role: 'error',
					text: `View refresh failed: ${
						error instanceof Error
							? error.message.slice(0, ERROR_BOUND)
							: String(error)
					}`,
				},
			]);
		}
	}

	function ensureAgent(): Agent | null {
		if (agentRef.current) return agentRef.current;
		const models = modelsRef.current;
		const live = models?.getModel(providerId, modelId) as
			| Model<string>
			| undefined;
		const client = uktubProjectService.getClient();
		if (!models || !live || !client || surfaceTools.length === 0) return null;
		// The compile hook brackets the page BusyTeX run with the worker
		// prepare/finish; without a compile budget from the surface the tool
		// falls back to a plain callTool (engine-missing refusal).
		const compileHook =
			typeof compileTimeoutMs === 'number' &&
			surfaceTools.some((st) => st.name === 'compile')
				? {
						execute: (args: Record<string, unknown>, signal?: AbortSignal) =>
							executeAgentCompile(
								{
									entry:
										typeof args.entry === 'string' ? args.entry : undefined,
								},
								{
									signal,
									deps: {
										ops: {
											prepare: (entry) => client.compilePrepare(entry),
											finish: (fargs) =>
												client.compileFinish(fargs) as Promise<CoreToolResult>,
										},
										flush: () => uktubProjectService.flush(),
										run: (rel, sig) => compileForAgent(rel, sig),
										stop: () => stopCompilation(),
										timeoutMs: compileTimeoutMs as number,
										engineLabel: BUSYTEX_ENGINE_LABEL,
									},
								},
							),
					}
				: undefined;
		const tools = [
			...buildUktubAgentTools(client, surfaceTools, {
				...(compileHook ? { compile: compileHook } : {}),
				// Phase 9d D2: the worker-side refresh completes inside the
				// registry execute, never only in the un-awaited listener below.
				// `refreshAfterTool` never throws (failures become an error row).
				afterRegistry: () => refreshAfterTool('registry', undefined),
			}),
			// Phase 9d D2: the view refresh completes inside `write`/`edit`.
			...buildFileTools(client, {
				afterWrite: (rel) => refreshAfterTool('write', { path: rel }),
			}),
			// Phase 8b: one shared write_section definition (root src/agent/).
			// The child runs on the parent's current model and key; the gate
			// only ever sees this parent agent's events, never the child's.
			buildWriteSectionTool({
				getModel: () => agentRef.current?.state.model,
				getApiKey: (provider: string) => getAgentKey(provider) ?? undefined,
				streamFn: models.streamSimple.bind(models),
				systemPrompt: systemPromptText,
				// Phase 9d D3: each child retry gets the same visible row as a
				// parent retry, headed by the child tool name.
				onChildRetry: (info) => addRetryRow(info, 'write_section'),
				// Phase 9i: the child derives its own stable id from this.
				getSessionId: () => agentRef.current?.sessionId ?? getOrCreateSessionId(docUrl),
				callWorkerTool: (name, args, opts) =>
					client.callTool(name as never, args, opts ?? {}) as Promise<CoreToolResult>,
			}),
		] as AgentTool[];
		// Phase 8a pre-completion gate: one adapter per agent (the panel remounts
		// per project, matching the worker's one gate per open project). The
		// follow-up is queued through the agent so the SAME run continues.
		const gateAdapter = createGateAdapter({
			gateStartUserPrompt: async () => {
				try {
					await client.gateStartUserPrompt();
				} catch {
					// Fail open: the run still works without a fresh budget.
				}
			},
			gateToolEnded: async (event) => {
				try {
					await client.gateToolEnded({
						toolName: event.toolName,
						args: event.args,
						isError: event.isError,
					});
				} catch {
					// Fail open: the settle audit still runs.
				}
			},
			gateSettle: async () => {
				try {
					return await client.gateSettle();
				} catch {
					return { text: null };
				}
			},
			addCheckMessage: (text) => {
				const id = idRef.current++;
				setTranscript((prev) => [...prev, { id, role: 'check', text }]);
			},
			followUp: (message) => {
				agentRef.current?.followUp(message);
			},
		});
		gateAdapterRef.current = gateAdapter;
		// Phase 9i: stable id for the life of this assistant conversation
		// in this project (the module map survives sidebar remounts), so
		// OpenRouter routing stays sticky turn after turn.
		const sessionId = getOrCreateSessionId(docUrl);
		const agent = new Agent({
			sessionId,
			initialState: {
				systemPrompt: systemPromptText,
				model: live,
				thinkingLevel: 'off',
				tools,
				messages: [],
			},
			streamFn: withAgentRetry(models.streamSimple.bind(models), {
				// Phase 9d D3: Node Pi parity — retryable assistant errors
				// retry with Pi's predicate and default policy, one visible
				// transcript row per retry, Stop aborting the pending wait.
				onRetry: (info) => addRetryRow(info),
			}),
			getApiKey: (pid: string) => getAgentKey(pid) ?? undefined,
			beforeToolCall: async () => {
				// Flush open editor buffers into the project (Phase 4
				// write-back) so tools see what the researcher just typed.
				await uktubProjectService.flush();
				return undefined;
			},
			finishTurn: (turn) => gateAdapter.finishTurn(turn),
		});
		unsubRef.current = agent.subscribe((event: AgentEvent) => {
			if (event.type === 'message_update') {
				const inner = event.assistantMessageEvent;
				if (inner.type === 'text_delta') appendToAssistant(inner.delta);
			} else if (event.type === 'tool_execution_start') {
				// Phase 8a: remember the call args for the gate (the end event
				// carries no args in pi-agent-core).
				gateAdapterRef.current?.rememberToolStart(event.toolCallId, event.args);
				addToolRow(event.toolCallId, event.toolName, event.args);
			} else if (event.type === 'tool_execution_end') {
				// Phase 8a: record the completed call for the gate (fail open).
				const gate = gateAdapterRef.current;
				if (gate) void gate.recordToolEnd(event.toolCallId, event.toolName, event.isError).catch(() => {});
				const preview = previewResult(event.result as { content?: unknown });
				// Phase 8b: the write_section row leads with the child's activity
				// summary (turns, tool calls, words, draft/final counts); the
				// bounded LaTeX follows in the same preview.
				const childSummary =
					event.toolName === 'write_section' ? writeSectionChildSummary(event.result) : '';
				const aborted = /abort/i.test(preview);
				patchToolRow(event.toolCallId, {
					status: aborted ? 'stopped' : event.isError ? 'error' : 'ok',
					preview: childSummary ? `${childSummary}\n${preview}` : preview,
				});
				if (!aborted && event.toolName === 'compile') {
					// Phase 9d D2: `write`/`edit`/`registry` refresh the view
					// inside their own execute (awaited, so no parallel tool
					// can reconcile the file away); only the compile PDF
					// still refreshes here, after the finish lands it.
					const pdfPath = (
						event.result as
							| { structuredContent?: { pdfPath?: unknown } }
							| undefined
					)?.structuredContent?.pdfPath;
					void refreshAfterTool(
						'compile',
						typeof pdfPath === 'string' ? { pdfPath } : undefined,
					);
				}
			} else if (event.type === 'message_end') {
				const msg = event.message;
				// Phase 9i: record the turn's usage on its transcript entry
				// (session only, never stored). The trailing assistant entry
				// is this turn's reply; a retry row may sit after it, so
				// search backwards. Without one (tool-only turn that left no
				// text), the usage gets its own empty assistant entry.
				const turnUsage = extractTurnUsage(msg);
				if (turnUsage !== null) {
					const usageId = idRef.current++;
					setTranscript((prev) => {
						for (let i = prev.length - 1; i >= 0; i--) {
							if (prev[i].role === 'assistant' && prev[i].usage === undefined) {
								const next = [...prev];
								next[i] = { ...next[i], usage: turnUsage };
								return next;
							}
						}
						return [...prev, { id: usageId, role: 'assistant', text: '', usage: turnUsage }];
					});
				}
				if (msg.role === 'assistant') {
					const stop = (msg as { stopReason?: string }).stopReason;
					const errText = (msg as { errorMessage?: string }).errorMessage;
					// A researcher Stop (abort) is not an error: the partial
					// reply stays and the panel just goes idle.
					if (stop === 'aborted') {
						setBusy(false);
						setAgentRunActive(false);
					} else if (stop === 'error') {
						const detail = (errText ?? 'The provider returned an error.').slice(
							0,
							ERROR_BOUND,
						);
						// Aborting mid-tool-call can surface here as an
						// "Operation aborted" error: still just a Stop.
						if (/abort/i.test(detail)) {
							setBusy(false);
							setAgentRunActive(false);
							return;
						}
						const id = idRef.current++;
						setTranscript((prev) => [
							...prev,
							{ id, role: 'error', text: detail },
						]);
						setBusy(false);
						setAgentRunActive(false);
					}
				}
			} else if (event.type === 'agent_end') {
				setBusy(false);
				setAgentRunActive(false);
			}
		});
		agentRef.current = agent;
		return agent;
	}

	// Load the worker's agent surface once the project bridge is ready, then
	// push the stored research-service keys into the worker.
	useEffect(() => {
		let cancelled = false;
		const load = async (): Promise<void> => {
			const client = uktubProjectService.getClient();
			if (!client) {
				if (!cancelled) {
					setSurfaceError(
						'The project bridge is not open yet. Reopen the project.',
					);
				}
				return;
			}
			try {
				const surface = await client.agentSurface();
				if (cancelled) return;
				setSurfaceTools(surface.tools);
				setSurfaceRules(surface.rules);
				setSurfaceWorkflow(typeof surface.workflow === 'string' ? surface.workflow : null);
				setResearchKeys(surface.keyNames);
				setCompileTimeoutMs(
					typeof surface.compileTimeoutMs === 'number'
						? surface.compileTimeoutMs
						: null,
				);
				// Phase 8b: worker-derived engine list (default openrouter); stale
				// workers predate the field, so fall back to the default.
				// Phase 9f: a stored `hosted` choice from an older session
				// falls back visibly (never a silent unreachable engine).
				const engines =
					Array.isArray(surface.verificationEngines) && surface.verificationEngines.length > 0
						? surface.verificationEngines
						: [VERIFY_ENGINE_DEFAULT];
				setVerificationEngines(engines);
				const initialEngine = resolveVerifyEngine(verifyEngine, engines);
				setVerifyEngine(initialEngine);
				setSurfaceError(null);
				try {
					// Phase 9h: the mount-time push sends the CURRENT settings
					// (restored from storage into state above), never literal
					// defaults: setEnv REPLACES the worker env, so defaults
					// here would silently drop the researcher's key and paid
					// model on every remount (sidebar view switches unmount
					// and remount this panel). The model goes over raw: the
					// catalog options may not be loaded yet at mount, and
					// resolving against [] would fall back to the free
					// default — dropping the paid choice this line must keep.
					// Within the session the stored id is catalog-valid (it
					// was picked from these options), so raw matches the
					// pre-remount push exactly.
					await pushEnv(surface.keyNames, initialEngine, verifyUseModelKey, verifyModel);
					if (initialEngine !== verifyEngine) {
						saveVerifySelection({
							engine: initialEngine,
							useModelKey: verifyUseModelKey,
							model: verifyModel,
						});
					}
				} catch {
					// Keys apply on the next settings change; the run still works.
				}
			} catch (err) {
				if (!cancelled) {
					setSurfaceError(
						err instanceof Error
							? err.message.slice(0, ERROR_BOUND)
							: String(err),
					);
				}
			}
		};
		void load();
		return () => {
			cancelled = true;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [docUrl]);

	async function pushEnv(keys: string[], engine: string, useModelKey: boolean, model: string): Promise<void> {
		const client = uktubProjectService.getClient();
		if (!client) return;
		// setEnv REPLACES the worker env: research keys and verify settings
		// always travel together, or one push would wipe the other.
		try {
			await client.setEnv({
				...buildResearchEnv(keys),
				...buildVerifyEnv({
					engine,
					openRouterKey: resolveOpenRouterKey({
						useModelKey,
						modelKey: getAgentKey('openrouter'),
						separateKey: getResearchKey(OPENROUTER_KEY_ENV),
					}),
					verifyModel: model,
				}),
			});
		} catch {
			// Best effort: the settings stay stored and apply on the next change.
		}
	}

	async function pushResearchKeys(keys: string[]): Promise<void> {
		await pushEnv(keys, effectiveVerifyEngine, verifyUseModelKey, effectiveVerifyModel);
	}

	async function handleResearchSave(
		name: string,
		key: string,
		rememberKey: boolean,
	): Promise<void> {
		saveResearchKey(name, key, { remember: rememberKey });
		setResearchTick((n) => n + 1);
		await pushResearchKeys(researchKeys);
	}

	async function handleResearchForget(name: string): Promise<void> {
		forgetResearchKey(name);
		setResearchTick((n) => n + 1);
		await pushResearchKeys(researchKeys);
	}

	async function handleVerifyEngine(engine: string): Promise<void> {
		setVerifyEngine(engine);
		saveVerifySelection({ engine, useModelKey: verifyUseModelKey, model: verifyModel });
		await pushEnv(researchKeys, engine, verifyUseModelKey, effectiveVerifyModel);
	}

	async function handleVerifyUseModelKey(use: boolean): Promise<void> {
		setVerifyUseModelKey(use);
		saveVerifySelection({ engine: verifyEngine, useModelKey: use, model: verifyModel });
		await pushEnv(researchKeys, effectiveVerifyEngine, use, effectiveVerifyModel);
	}

	async function handleVerifyModel(model: string): Promise<void> {
		setVerifyModel(model);
		saveVerifySelection({ engine: verifyEngine, useModelKey: verifyUseModelKey, model });
		await pushEnv(researchKeys, effectiveVerifyEngine, verifyUseModelKey, model);
	}

	async function handleSend(): Promise<void> {
		const text = input.trim();
		if (!text || busy || !catalog) return;
		const models = await getAgentModels();
		modelsRef.current = models;
		const live = models.getModel(providerId, modelId) as
			| Model<string>
			| undefined;
		if (!live) {
			const id = idRef.current++;
			setTranscript((prev) => [
				...prev,
				{ id, role: 'error', text: 'Select a model first.' },
			]);
			return;
		}
		const client = uktubProjectService.getClient();
		if (!client) {
			const id = idRef.current++;
			setTranscript((prev) => [
				...prev,
				{ id, role: 'error', text: 'The project bridge is not open.' },
			]);
			return;
		}
		if (surfaceTools.length === 0 && !surfaceError) {
			const id = idRef.current++;
			setTranscript((prev) => [
				...prev,
				{
					id,
					role: 'error',
					text: 'The agent tools are still loading. Try again in a moment.',
				},
			]);
			return;
		}
		const agent = ensureAgent();
		if (!agent) return;
		// Switching the picker applies to the next prompt.
		agent.state.model = live as never;
		const userId = idRef.current++;
		const asstId = idRef.current++;
		setTranscript((prev) => [
			...prev,
			{ id: userId, role: 'user', text },
			{ id: asstId, role: 'assistant', text: '' },
		]);
		setInput('');
		setBusy(true);
		setAgentRunActive(true);
		try {
			// Phase 8a: a user prompt starts a new gate budget (the gate's own
			// continuations never reset it). Fail open.
			try {
				await gateAdapterRef.current?.startUserPrompt();
			} catch {
				// The run still works without a fresh budget.
			}
			await agent.prompt(text);
		} catch (err) {
			// Abort (Stop) is not an error: the partial reply stays, panel goes idle.
			if (!(err instanceof Error && /abort/i.test(err.message))) {
				const detail =
					err instanceof Error
						? err.message.slice(0, ERROR_BOUND)
						: String(err).slice(0, ERROR_BOUND);
				const id = idRef.current++;
				setTranscript((prev) => [...prev, { id, role: 'error', text: detail }]);
			}
		} finally {
			setBusy(false);
			setAgentRunActive(false);
		}
	}

	function handleStop(): void {
		agentRef.current?.abort();
	}

	if (catalogError) {
		return (
			<div className='agent-panel' data-role='agent-panel'>
				<p className='ui-message' data-tone='error'>
					{catalogError}
				</p>
			</div>
		);
	}
	if (!catalog || !provider) {
		return (
			<div className='agent-panel' data-role='agent-panel'>
				<p className='ui-note'>{t('Loading models…')}</p>
			</div>
		);
	}

	const settingsOpen = !settingsCollapsed || keyStatus !== 'ok';

	return (
		<div className='agent-panel' data-role='agent-panel'>
			{settingsOpen ? (
				<>
					<div className='agent-section'>
						<label className='ui-note' htmlFor='agent-provider'>
							{t('Provider')}
						</label>
						<select
							id='agent-provider'
							data-role='agent-provider-select'
							value={providerId}
							onChange={(e) => selectProvider(e.target.value)}
						>
							{catalog.map((p) => (
								<option key={p.id} value={p.id} disabled={p.signInOnly}>
									{p.name}
									{p.signInOnly
										? ` (${t('sign-in only — not in this version')})`
										: ''}
								</option>
							))}
						</select>
						{provider.signInOnly ? (
							<p className='ui-note' data-role='agent-provider-note'>
								{t('This provider needs sign-in (no API key in this version).')}
							</p>
						) : (
							<p className='ui-note' data-role='agent-provider-note'>
								{t('Key')}: {provider.keyLabel}
							</p>
						)}
					</div>

					<div className='agent-section'>
						<label className='ui-note' htmlFor='agent-model-filter'>
							{t('Model')} ({provider.models.length})
						</label>
						<input
							id='agent-model-filter'
							data-role='agent-model-filter'
							type='search'
							role='combobox'
							aria-expanded={modelOpen}
							aria-controls='agent-model-listbox'
							placeholder={
								selectedModel
									? selectedModel.name || selectedModel.id
									: t('Search models…')
							}
							value={modelFilter}
							onChange={(e) => {
								setModelFilter(e.target.value);
								setModelOpen(true);
							}}
							onFocus={(e) => {
								e.currentTarget.select();
								setModelOpen(true);
							}}
							onBlur={() => setModelOpen(false)}
							onKeyDown={(e) => {
								if (e.key === 'Escape') setModelOpen(false);
							}}
						/>
						{modelOpen ? (
							<div
								className='agent-model-list'
								data-role='agent-model-list'
								role='listbox'
								id='agent-model-listbox'
								style={{ maxHeight: '180px', overflowY: 'auto' }}
							>
								{filteredModels.slice(0, MODEL_DROPDOWN_CAP).map((m) => (
									<button
										key={`${m.providerId}/${m.id}`}
										type='button'
										role='option'
										aria-selected={m.id === modelId}
										data-role='agent-model-option'
										data-model-id={m.id}
										className={m.id === modelId ? 'active' : undefined}
										onMouseDown={(e) => {
											// Keep focus (and the open dropdown) until click processes.
											e.preventDefault();
										}}
										onClick={() => selectModel(m.id)}
										title={`${m.name} — ctx ${formatCtx(m.contextWindow)} — ${formatCost(m)}`}
									>
										<span className='agent-model-name'>{m.name || m.id}</span>{' '}
										<span className='ui-note'>
											ctx {formatCtx(m.contextWindow)} · {formatCost(m)}
											{m.free ? ` · ${t('free')}` : ''}
										</span>
									</button>
								))}
							</div>
						) : null}
						{modelOpen && filteredModels.length > MODEL_DROPDOWN_CAP ? (
							<p className='ui-note'>
								{t('Showing')} {MODEL_DROPDOWN_CAP} {t('of')}{' '}
								{filteredModels.length} — {t('refine the search.')}
							</p>
						) : null}
					</div>

					{!provider.signInOnly && (
						<div className='agent-section'>
							<label className='ui-note' htmlFor='agent-key'>
								{provider.keyLabel} (
								{t('never leaves this browser except to the provider')})
							</label>
							<input
								id='agent-key'
								data-role='agent-key-input'
								type='password'
								autoComplete='off'
								placeholder={t('Paste key…')}
								value={keyDraft}
								onChange={(e) => setKeyDraft(e.target.value)}
							/>
							<label className='ui-note'>
								<input
									type='checkbox'
									data-role='agent-remember'
									checked={remember}
									onChange={(e) => setRemember(e.target.checked)}
								/>{' '}
								{t('Remember on this device')}
							</label>
							<div className='ui-actions'>
								<button
									type='button'
									className='button'
									data-role='agent-test'
									disabled={testing}
									onClick={handleTest}
								>
									{testing ? t('Testing…') : t('Test')}
								</button>
								<button
									type='button'
									className='button primary'
									data-role='agent-save'
									onClick={handleSave}
								>
									{t('Save')}
								</button>
								<button
									type='button'
									className='button'
									data-role='agent-forget'
									onClick={handleForget}
								>
									{t('Forget')}
								</button>
							</div>
							{keyStatus ? (
								<p
									className='ui-note'
									data-role='agent-status'
									data-status={keyStatus}
								>
									{keyStatus === 'ok'
										? t('Key accepted.')
										: keyStatus === 'rejected'
											? t('Key rejected by the provider.')
											: keyStatus === 'blocked'
												? t('Blocked by the browser or unreachable.')
												: t('Test failed.')}
									{keyDetail ? ` ${keyDetail}` : ''}
								</p>
							) : null}
						</div>
					)}

					<div className='agent-section' data-role='agent-research-keys'>
						<p className='ui-note'>{t('Research services')}</p>
						{researchKeys.length === 0 ? (
							<p className='ui-note'>{t('Loading…')}</p>
						) : (
							researchKeys.map((name) => (
								<ResearchKeyRow
									key={`${name}-${researchTick}`}
									name={name}
									onSave={handleResearchSave}
									onForget={handleResearchForget}
								/>
							))
						)}
					</div>

					<div className='agent-section' data-role='agent-verify-engine'>
						<label className='ui-note' htmlFor='agent-verify-engine-select'>
							{t('Verification')}
						</label>
						<select
							id='agent-verify-engine-select'
							data-role='agent-verify-engine-select'
							value={effectiveVerifyEngine}
							onChange={(e) => void handleVerifyEngine(e.target.value)}
						>
							{(verificationEngines.length > 0 ? verificationEngines : [VERIFY_ENGINE_DEFAULT]).map(
								(name) => (
									<option key={name} value={name}>
										{name}
									</option>
								),
							)}
						</select>
						{effectiveVerifyEngine === 'openrouter' ? (
							<>
								<label className='ui-note' htmlFor='agent-verify-model-select'>
									{t('Verification model')}
								</label>
								<select
									id='agent-verify-model-select'
									data-role='agent-verify-model-select'
									value={effectiveVerifyModel}
									onChange={(e) => void handleVerifyModel(e.target.value)}
								>
									{(verifyModelOptions.length > 0
										? verifyModelOptions
										: [{ id: VERIFY_MODEL_DEFAULT, name: VERIFY_MODEL_DEFAULT, free: true, priceLabel: 'free' }]
									).map((m) => (
										<option
											key={m.id}
											value={m.id}
											data-role='agent-verify-model-option'
											data-model-id={m.id}
										>
											{m.name} — {m.priceLabel}
										</option>
									))}
								</select>
								<label className='ui-note'>
									<input
										type='checkbox'
										data-role='agent-verify-use-model-key'
										checked={verifyUseModelKey}
										onChange={(e) => void handleVerifyUseModelKey(e.target.checked)}
									/>{' '}
									{t('Use my OpenRouter key from the model settings')}
								</label>
								{verifyUseModelKey ? null : (
									<ResearchKeyRow
										key={`${OPENROUTER_KEY_ENV}-${researchTick}`}
										name={OPENROUTER_KEY_ENV}
										onSave={handleResearchSave}
										onForget={handleResearchForget}
									/>
								)}
							</>
						) : null}
					</div>
				</>
			) : (
				<div className='agent-section'>
					<p className='ui-note' data-role='agent-settings-summary'>
						{provider.name} · {selectedModel?.name || modelId} · {t('key ok')} ·{' '}
						{t('verify')}: {effectiveVerifyEngine} · {effectiveVerifyModel} ·{' '}
						<button
							type='button'
							className='button'
							data-role='agent-settings-change'
							onClick={() => setSettingsCollapsed(false)}
						>
							{t('change')}
						</button>
					</p>
				</div>
			)}

			{surfaceError ? (
				<div className='agent-section'>
					<p
						className='ui-message'
						data-tone='error'
						data-role='agent-surface-error'
					>
						{surfaceError}
					</p>
				</div>
			) : null}

			<div className='agent-section agent-chat'>
				<div className='agent-transcript' data-role='agent-transcript'>
					{transcript.map((e) => (
						<div
							key={e.id}
							className={`agent-msg agent-msg-${e.role}`}
							data-role={`agent-msg-${e.role}`}
						>
							{e.role === 'check' ? (
								<>
									<span className='agent-check-label' data-role='agent-check-label'>
										Uktub check
									</span>{' '}
									{e.text}
								</>
							) : (
								e.text || (e.role === 'assistant' && busy ? '…' : '')
							)}
							{e.role === 'assistant' && e.usage !== undefined ? (
								<div className='ui-note' data-role='agent-usage-line'>
									{formatUsageLine(e.usage)}
								</div>
							) : null}
						</div>
					))}
					{toolRows.map((r) => (
						<ToolRowView key={r.id} row={r} />
					))}
				</div>
				<div className='ui-actions'>
					<input
						data-role='agent-input'
						type='text'
						placeholder={t('Ask about your manuscript…')}
						value={input}
						onChange={(e) => setInput(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === 'Enter') void handleSend();
						}}
						disabled={busy}
					/>
					{busy ? (
						<button
							type='button'
							className='button'
							data-role='agent-stop'
							onClick={handleStop}
						>
							{t('Stop')}
						</button>
					) : (
						<button
							type='button'
							className='button primary'
							data-role='agent-send'
							onClick={() => void handleSend()}
							disabled={!input.trim()}
						>
							{t('Send')}
						</button>
					)}
				</div>
			</div>
		</div>
	);
};

function ToolRowView({ row }: { row: ToolRow }) {
	const [open, setOpen] = useState(true);
	const dot = row.status === 'running' ? '…' : row.status;
	return (
		<div
			className={`agent-tool agent-tool-${row.status}`}
			data-role='agent-tool-row'
			data-tool={row.name}
			data-status={row.status}
		>
			<button
				type='button'
				className='agent-tool-head'
				data-role='agent-tool-toggle'
				onClick={() => setOpen((o) => !o)}
				title={row.argsSummary}
			>
				<span className='agent-tool-name'>{row.name}</span>{' '}
				<span className='ui-note agent-tool-args'>{row.argsSummary}</span>{' '}
				<span className='ui-note agent-tool-status'>· {dot}</span>
			</button>
			{open && row.preview ? (
				<pre
					className='ui-note agent-tool-preview'
					data-role='agent-tool-preview'
				>
					{row.preview}
				</pre>
			) : null}
		</div>
	);
}

function ResearchKeyRow({
	name,
	onSave,
	onForget,
}: {
	name: string;
	onSave: (name: string, key: string, remember: boolean) => Promise<void>;
	onForget: (name: string) => Promise<void>;
}) {
	const [draft, setDraft] = useState('');
	const [rememberKey, setRememberKey] = useState(false);
	const [saved, setSaved] = useState(() => getResearchKey(name) !== undefined);
	const save = async (): Promise<void> => {
		const key = draft;
		if (!key) return;
		await onSave(name, key, rememberKey);
		setDraft('');
		setSaved(true);
	};
	return (
		<div
			className='agent-research-key'
			data-role='agent-research-key'
			data-key-name={name}
		>
			<label className='ui-note' htmlFor={`agent-research-${name}`}>
				{name}
			</label>
			<input
				id={`agent-research-${name}`}
				data-role='agent-research-input'
				data-key-name={name}
				type='password'
				autoComplete='off'
				placeholder={saved ? t('Set — paste to replace…') : t('Paste key…')}
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter') void save();
				}}
			/>
			<label className='ui-note'>
				<input
					type='checkbox'
					data-role='agent-research-remember'
					data-key-name={name}
					checked={rememberKey}
					onChange={(e) => setRememberKey(e.target.checked)}
				/>{' '}
				{t('Remember on this device')}
			</label>
			<div className='ui-actions'>
				<button
					type='button'
					className='button'
					data-role='agent-research-save'
					data-key-name={name}
					onClick={() => void save()}
					disabled={!draft}
				>
					{t('Save')}
				</button>
				{saved ? (
					<button
						type='button'
						className='button'
						data-role='agent-research-forget'
						data-key-name={name}
						onClick={() => {
							void onForget(name).then(() => setSaved(false));
						}}
					>
						{t('Forget')}
					</button>
				) : null}
			</div>
		</div>
	);
}

export default AgentPanel;
