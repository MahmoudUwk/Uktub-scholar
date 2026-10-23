// SPDX-License-Identifier: AGPL-3.0-or-later
// Phase 9d D2 (TDD-first): the view/worker race.
//
// (ii) `reconcile` never deletes a `/proj` file the view never had: the
// file is pulled INTO the view instead. Deletions of files the view knew
// stay handled by the existing `lastPushed` loop.
// (iii) One assistant message with two parallel tool calls — `write` a NEW
// section file, then `compile` — through the real panel agent wiring
// (pi-ai faux provider, real `Agent` loop, default parallel execution):
// the compile stages the new file and the file still exists in `/proj`
// afterwards. This is the Phase 8b crash shape (`transcript8b.json`:
// every agent compile missed `sections/01-introduction.tex`).
import { Agent } from '@earendil-works/pi-agent-core';
import type { AgentTool } from '@earendil-works/pi-agent-core';
import { createModels } from '@earendil-works/pi-ai';
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux';

import { executeAgentCompile } from '../../../src/services/agent/agentCompile';
import { buildFileTools, type ProjectFileClient } from '../../../src/services/agent/agentUktubTools';
import { UKTUB_BIB } from '../../../src/services/uktubPaths';
import { fileStoreService } from '../../../src/services/FileStoreService';
import { uktubProjectService } from '../../../src/services/UktubProjectService';
import type { FileNode } from '../../../src/types/files';

const MAIN_REL = 'manuscript/main.tex';
const SECTION_REL = 'manuscript/sections/01-introduction.tex';
const MAIN_STORE = '/manuscript/main.tex';
const SECTION_STORE = '/manuscript/sections/01-introduction.tex';
const SENTENCE = 'A fresh section sentence.';

function fileNode(id: string, path: string, name: string, content: string): FileNode {
	return { id, name, path, type: 'file', content, lastModified: Date.now(), size: content.length, mimeType: 'text/plain', isBinary: false };
}

interface FakeProj {
	files: Map<string, string>;
	deleted: string[];
	written: string[];
}

function fakeClient(proj: FakeProj): ProjectFileClient & { listFiles(): Promise<{ files: { path: string; size: number }[] }> } {
	return {
		async readFile(rel: string) {
			if (rel === UKTUB_BIB) return { path: rel, bytes: 3, text: '' };
			const text = proj.files.get(rel);
			if (text === undefined) throw new Error(`readFile: no such file (${rel})`);
			return { path: rel, bytes: text.length, text };
		},
		async writeFile(rel: string, content: string | Uint8Array) {
			const text = typeof content === 'string' ? content : new TextDecoder().decode(content);
			proj.files.set(rel, text);
			proj.written.push(rel);
			return { path: rel, bytes: text.length };
		},
		async listFiles() {
			return { files: [...proj.files.keys()].map((path) => ({ path, size: 0 })) };
		},
		async callTool() {
			throw new Error('no surface tools in this harness');
		},
	} as unknown as ProjectFileClient & { listFiles(): Promise<{ files: { path: string; size: number }[] }> };
}

function armService(client: unknown): void {
	const svc = uktubProjectService as unknown as {
		client: unknown;
		projectId: string | null;
		status: { kind: string; message: string | null };
		lastPushed: Map<string, string>;
		pushTimers: Map<string, unknown>;
		reconcileTimer: ReturnType<typeof setTimeout> | null;
	};
	svc.client = client;
	svc.projectId = 'test-d2';
	svc.status = { kind: 'ready', message: null };
	svc.lastPushed = new Map();
	svc.pushTimers = new Map();
	svc.reconcileTimer = null;
}

async function seedView(): Promise<void> {
	await fileStoreService.initialize('yjs:test-d2');
	await fileStoreService.storeFile(fileNode('d2-main', MAIN_STORE, 'main.tex', 'Hello.\n'));
}

async function clearView(): Promise<void> {
	for (const f of await fileStoreService.getAllFiles(true, false, false)) {
		await fileStoreService.deleteFile(f.id, { showDeleteDialog: false }).catch(() => undefined);
	}
	fileStoreService.cleanup();
}

describe('reconcile keeps and pulls files the view never had (D2)', () => {
	let proj: FakeProj;

	beforeEach(async () => {
		proj = { files: new Map([[MAIN_REL, 'Hello.\n']]), deleted: [], written: [] };
		const client = fakeClient(proj);
		(client as unknown as { deleteFile: (rel: string) => Promise<unknown> }).deleteFile = async (rel: string) => {
			proj.deleted.push(rel);
			proj.files.delete(rel);
			return { path: rel };
		};
		armService(client);
		await seedView();
	});

	afterEach(async () => {
		await clearView();
		armService(null);
	});

	it('a /proj file absent from the view and lastPushed is pulled, not deleted', async () => {
		// An agent `write` landed in /proj while the view refresh lagged.
		proj.files.set(SECTION_REL, SENTENCE);
		await uktubProjectService.reconcile();
		expect(proj.deleted).not.toContain(SECTION_REL);
		expect(proj.files.get(SECTION_REL)).toBe(SENTENCE);
		const inView = await fileStoreService.getFileByPath(SECTION_STORE, true);
		expect(inView?.type).toBe('file');
	});

	it('a /proj file the view knew and dropped is still deleted', async () => {
		// The real flow that teaches `reconcile` a file: an agent write or
		// editor save refreshes/pushes it (populating `lastPushed`).
		await fileStoreService.storeFile(fileNode('d2-gone', '/manuscript/gone.tex', 'gone.tex', 'bye\n'));
		proj.files.set('manuscript/gone.tex', 'bye\n');
		await uktubProjectService.refreshAgentPaths(['manuscript/main.tex', 'manuscript/gone.tex']);
		await fileStoreService.deleteFile('d2-gone', { showDeleteDialog: false });
		await uktubProjectService.reconcile();
		expect(proj.deleted).toContain('manuscript/gone.tex');
	});

	it('write returns only after the view refresh completed', async () => {
		const client = fakeClient(proj);
		const tools = buildFileTools(client, {
			afterWrite: (rel) => uktubProjectService.refreshAgentPaths([rel]),
		});
		const write = tools.find((t) => t.name === 'write') as AgentTool;
		const out = await (write.execute as Function)('call-1', { path: SECTION_REL, content: SENTENCE }, undefined, undefined);
		expect((out as { isError?: boolean }).isError).not.toBe(true);
		const inView = await fileStoreService.getFileByPath(SECTION_STORE, true);
		expect((inView as FileNode | undefined)?.content).toBe(SENTENCE);
	});

	it('parallel write-then-compile stages the new file and keeps it in /proj', async () => {
		const client = fakeClient(proj);
		(client as unknown as { deleteFile: (rel: string) => Promise<unknown> }).deleteFile = async (rel: string) => {
			proj.deleted.push(rel);
			proj.files.delete(rel);
			return { path: rel };
		};
		armService(client);
		let stagedPaths: string[] = [];
		const tools = buildFileTools(client);
		const compile = {
			name: 'compile',
			label: 'compile',
			description: 'compile the manuscript',
			parameters: { type: 'object', properties: {} },
			execute: async (_id: string, _params: unknown, signal?: AbortSignal) =>
				executeAgentCompile(
					{},
					{
						signal,
						deps: {
							ops: {
								prepare: async () => ({ ok: true as const, rel: MAIN_REL }),
								finish: async () => ({
									content: [{ type: 'text' as const, text: 'compiled' }],
									structuredContent: null,
									details: {},
								}),
							},
							flush: () => uktubProjectService.flush(),
							run: async () => {
								stagedPaths = (await fileStoreService.buildFileTree())
									.filter((n) => n.type === 'file')
									.map((n) => n.path);
								return { status: 0, log: 'ok', pdf: new Uint8Array([9]) };
							},
							stop: () => undefined,
							timeoutMs: 30_000,
							engineLabel: 'busytex 1.4.1',
						},
					},
				),
		} as unknown as AgentTool;
		const faux = fauxProvider();
		const models = createModels();
		models.setProvider(faux.provider);
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall('write', { path: SECTION_REL, content: SENTENCE }),
				fauxToolCall('compile', {}),
			]),
			fauxAssistantMessage('done.'),
		]);
		const model = faux.getModel();
		const agent = new Agent({
			initialState: { systemPrompt: 't', model: model as never, tools: [...tools, compile], messages: [] },
			streamFn: models.streamSimple.bind(models),
			beforeToolCall: async () => {
				await uktubProjectService.flush();
				return undefined;
			},
		});
		// Default execution is parallel (pi-agent-core `toolExecution ?? "parallel"`).
		expect(agent.toolExecution).toBe('parallel');
		await agent.prompt('write the section and compile');
		expect(stagedPaths).toContain(SECTION_STORE);
		expect(proj.files.get(SECTION_REL)).toBe(SENTENCE);
	});
});
