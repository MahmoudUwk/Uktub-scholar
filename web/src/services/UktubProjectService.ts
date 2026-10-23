// Uktub `/proj` (OPFS) ownership bridge for the TeXlyre fork.
//
// The Uktub worker owns every project file under `/proj`. TeXlyre's
// FileStoreService (IndexedDB) is a read-through view: on project open this
// service rebuilds it from `listFiles`/`readFile`, and every local mutation
// (editor saves via `fileStorageEventEmitter`, deletes, renames) is mirrored
// back through `writeFile`/`deleteFile`. Tool-owned paths
// (`refs/references.bib`, `.registry/*`) are pulled read-only, never written.
//
// One worker per opened project; `init` carries the stable TeXlyre project id
// and surfaces the second-tab lock refusal instead of corrupting state.
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { nanoid } from 'nanoid';

import { UktubBrowserClient } from '../../../src/browser/client.ts';
import type { FileNode } from '../types/files';
import { getMimeType, isBinaryFile } from '../utils/fileUtils';
import { documentFileSyncService } from './DocumentFileSyncService';
import { emitAgentFilesChanged } from './agent/agentRunLock';
import {
	fileStorageEventEmitter,
	fileStoreService,
} from './FileStoreService';
import {
	UKTUB_BIB,
	UKTUB_MAIN_TEX,
	UKTUB_MAIN_TEX_TEMPLATE,
	UKTUB_RESULTS_DIR,
	UKTUB_SECTIONS_DIR,
	isUktubToolOwned,
	parentDirsOf,
	toStorePath,
	toUktubRel,
} from './uktubPaths';

export type UktubStatusKind =
	| 'idle'
	| 'opening'
	| 'ready'
	| 'locked'
	| 'error';

export interface UktubStatus {
	kind: UktubStatusKind;
	/** Human-readable reason for `locked`/`error` (shown in UI). */
	message: string | null;
}

export class UktubLockError extends Error {
	readonly reason: string;
	constructor(reason: string) {
		super(
			reason === 'open-in-another-tab'
				? 'This project is open in another tab. Close it there first.'
				: `Uktub project refused: ${reason}`,
		);
		this.name = 'UktubLockError';
		this.reason = reason;
	}
}

const PUSH_DEBOUNCE_MS = 700;
const RECONCILE_DEBOUNCE_MS = 900;

function hashContent(content: string | ArrayBuffer): string {
	if (typeof content === 'string') {
		let h = 5381;
		for (let i = 0; i < content.length; i++) {
			h = ((h << 5) + h + content.charCodeAt(i)) >>> 0;
		}
		return `t:${content.length}:${h.toString(36)}`;
	}
	const bytes = new Uint8Array(content);
	let h = 5381;
	const n = bytes.length;
	const sample = (i: number): number => bytes[i] ?? 0;
	for (let i = 0; i < Math.min(n, 512); i++) {
		h = ((h << 5) + h + sample(i)) >>> 0;
	}
	for (let i = Math.max(0, n - 512); i < n; i++) {
		h = ((h << 5) + h + sample(i)) >>> 0;
	}
	return `b:${n}:${h.toString(36)}`;
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
	const bin = atob(base64);
	const bytes = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
	return bytes.buffer as ArrayBuffer;
}

function baseNameOf(storePath: string): string {
	const rel = toUktubRel(storePath);
	const idx = rel.lastIndexOf('/');
	return idx === -1 ? rel : rel.slice(idx + 1);
}

class UktubProjectService {
	private client: UktubBrowserClient | null = null;
	private worker: Worker | null = null;
	private projectId: string | null = null;
	private status: UktubStatus = { kind: 'idle', message: null };
	private listeners = new Set<(status: UktubStatus) => void>();
	/** While > 0, storage events from our own sync-down are ignored. */
	private muted = 0;
	/** `/proj` rels pulled into the view by the current `reconcile`. */
	private pulledDuringReconcile: string[] = [];
	private pushTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
	/** Last bytes known to be in `/proj`, by store path (`/a/b.tex`). */
	private lastPushed = new Map<string, string>();
	private unloadHookInstalled = false;
	private subscribed = false;

	getStatus(): UktubStatus {
		return this.status;
	}

	subscribe(listener: (status: UktubStatus) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private setStatus(kind: UktubStatusKind, message: string | null = null): void {
		this.status = { kind, message };
		for (const listener of this.listeners) listener(this.status);
	}

	private ensureSubscribed(): void {
		if (this.subscribed) return;
		this.subscribed = true;
		fileStorageEventEmitter.onChange((change) => {
			void this.handleStorageChange(change.filePath);
		});
	}

	getProjectId(): string | null {
		return this.projectId;
	}

	getClient(): UktubBrowserClient | null {
		return this.client;
	}

	/**
	 * Open (or reuse) the worker for a TeXlyre project and rebuild its
	 * FileStore view from `/proj`. Each TeXlyre project maps to its own
	 * Uktub `projectId` (its own OPFS-backed storage); only a second-tab
	 * open of the SAME project throws UktubLockError. Returns whether a
	 * fresh layout was created.
	 */
	async openProject(texlyreProjectId: string): Promise<{ freshLayout: boolean }> {
		this.ensureSubscribed();
		this.ensureUnloadHook();
		if (this.client && this.projectId === texlyreProjectId) {
			return { freshLayout: false };
		}
		if (this.client) await this.close();
		this.setStatus('opening');
		const base = import.meta.env.BASE_URL || '/';
		const workerUrl = `${base.replace(/\/$/, '')}/uktub/worker.js`;
		const worker = new Worker(workerUrl, { type: 'module' });
		const client = new UktubBrowserClient(worker);
		try {
			await client.ready;
			const res = (await client.init({
				projectId: texlyreProjectId,
			})) as unknown as { ok: boolean; reason?: string };
			if (!res || res.ok !== true) {
				throw new UktubLockError(
					(res as { reason?: string } | null)?.reason ?? 'refused',
				);
			}
		} catch (error) {
			client.terminate();
			if (error instanceof UktubLockError) {
				this.setStatus('locked', error.message);
			} else {
				this.setStatus(
					'error',
					error instanceof Error ? error.message : String(error),
				);
			}
			throw error;
		}
		this.worker = worker;
		this.client = client;
		this.projectId = texlyreProjectId;
		// Acceptance seam (Phase 9a): only in builds with
		// VITE_UKTUB_ACCEPTANCE_SEAMS=1; the production bundle drops this branch.
		if (import.meta.env.VITE_UKTUB_ACCEPTANCE_SEAMS === '1') {
			const service = this;
			try {
				(window as unknown as { __uktub?: unknown }).__uktub = {
					service,
					get client() {
						return service.getClient();
					},
					get projectId() {
						return service.getProjectId();
					},
					get status() {
						return service.getStatus();
					},
					/** Close the IndexedDB view (test seam for the "reload rebuilds
					 * from `/proj`" proof; the view reopens on next use). */
					closeView() {
						fileStoreService.cleanup();
					},
				};
			} catch {
				// Non-DOM test environment; the seam is optional.
			}
		}
		try {
			const freshLayout = await this.syncDownToStore();
			this.setStatus('ready');
			return { freshLayout };
		} catch (error) {
			await this.close();
			this.setStatus(
				'error',
				error instanceof Error ? error.message : String(error),
			);
			throw error;
		}
	}

	/**
	 * Full rebuild of the FileStore view from `/proj`. Creates the fixed
	 * layout (`manuscript/main.tex`, placeholder dirs) when `/proj` is empty
	 * and `refs/references.bib` already exists (worker `init` renders it).
	 */
	private async syncDownToStore(): Promise<boolean> {
		const client = this.requireClient();
		const { files } = await client.listFiles();
		let freshLayout = false;
		let visible = files;
		// A fresh project holds only tool-owned files (worker `init` renders
		// `refs/references.bib`): seed the fixed layout then.
		const hasOwnedFiles = visible.some((f) => !isUktubToolOwned(f.path));
		if (!hasOwnedFiles) {
			await client.writeFile(UKTUB_MAIN_TEX, UKTUB_MAIN_TEX_TEMPLATE);
			freshLayout = true;
			visible = (await client.listFiles()).files;
		}
		this.muted++;
		try {
			const previous = await fileStoreService.getAllFiles(true, false, false);
			const keepByPath = new Map(
				previous
					.filter((f) => !f.isDeleted)
					.map((f) => [f.path, { id: f.id, documentId: f.documentId }]),
			);
			if (previous.length > 0) {
				await fileStoreService.batchDeleteFiles(
					previous.map((f) => f.id),
					{
						hardDelete: true,
						showDeleteDialog: false,
						allowLinkedFileDelete: true,
					},
				);
			}
			const nodes: FileNode[] = [];
			const dirPaths = new Set<string>();
			for (const f of visible) {
				for (const dir of parentDirsOf(toStorePath(f.path))) {
					dirPaths.add(dir);
				}
			}
			dirPaths.add(toStorePath(UKTUB_SECTIONS_DIR));
			dirPaths.add(toStorePath(UKTUB_RESULTS_DIR));
			for (const dirPath of [...dirPaths].sort()) {
				const kept = keepByPath.get(dirPath);
				nodes.push({
					id: kept?.id ?? nanoid(),
					name: baseNameOf(dirPath),
					path: dirPath,
					type: 'directory',
					...(kept?.documentId !== undefined
						? { documentId: kept.documentId }
						: {}),
					lastModified: Date.now(),
				});
			}
			const now = Date.now();
			const pushed = new Map<string, string>();
			for (const f of [...visible].sort((a, b) =>
				a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
			)) {
				const storePath = toStorePath(f.path);
				const read = f.path === UKTUB_BIB
					? await client.readFile(f.path)
					: isBinaryFile(f.path)
						? await client.readFile(f.path, 'base64')
						: await client.readFile(f.path);
				const kept = keepByPath.get(storePath);
				if (read.base64 !== undefined) {
					const content = base64ToArrayBuffer(read.base64);
					nodes.push({
						id: kept?.id ?? nanoid(),
						name: baseNameOf(storePath),
						path: storePath,
						type: 'file',
						content,
						isBinary: true,
						mimeType: getMimeType(f.path),
						...(kept?.documentId !== undefined
							? { documentId: kept.documentId }
							: {}),
						lastModified: now,
						size: read.bytes,
					});
					pushed.set(storePath, hashContent(content));
				} else {
					const content = read.text ?? '';
					nodes.push({
						id: kept?.id ?? nanoid(),
						name: baseNameOf(storePath),
						path: storePath,
						type: 'file',
						content,
						isBinary: false,
						mimeType: getMimeType(f.path),
						...(kept?.documentId !== undefined
							? { documentId: kept.documentId }
							: {}),
						lastModified: now,
						size: read.bytes,
					});
					pushed.set(storePath, hashContent(content));
				}
			}
			if (nodes.length > 0) {
				await fileStoreService.batchStoreFiles(nodes, {
					showConflictDialog: false,
					preserveTimestamp: true,
					preserveDeletionStatus: true,
				});
			}
			this.lastPushed = pushed;
		} finally {
			this.muted--;
		}
		fileStorageEventEmitter.emitChange();
		return freshLayout;
	}

	private handleStorageChange(filePath: string | undefined): void {
		if (this.muted > 0 || !this.client || !this.projectId) return;
		if (this.status.kind !== 'ready') return;
		if (filePath !== undefined) {
			const existing = this.pushTimers.get(filePath);
			if (existing !== undefined) clearTimeout(existing);
			this.pushTimers.set(
				filePath,
				setTimeout(() => {
					this.pushTimers.delete(filePath);
					void this.pushPath(filePath).catch((error) => {
						// Write-through must never break editing; reconcile on flush.
						console.warn('[uktub] push failed, will retry on flush:', error);
					});
				}, PUSH_DEBOUNCE_MS),
			);
			return;
		}
		this.scheduleReconcile();
	}

	private scheduleReconcile(): void {
		if (this.reconcileTimer !== null) clearTimeout(this.reconcileTimer);
		this.reconcileTimer = setTimeout(() => {
			this.reconcileTimer = null;
			void this.reconcile().catch((error) => {
				console.warn('[uktub] reconcile failed:', error);
			});
		}, RECONCILE_DEBOUNCE_MS);
	}

	/** Push one stored file to `/proj` (delete when gone, never tool-owned). */
	private async pushPath(storePath: string): Promise<void> {
		const client = this.client;
		if (!client) return;
		if (isUktubToolOwned(storePath)) return;
		const node = await fileStoreService.getFileByPath(storePath, true);
		const rel = toUktubRel(storePath);
		if (!node || node.type !== 'file' || node.isDeleted || node.content === undefined) {
			if (this.lastPushed.has(storePath)) {
				this.lastPushed.delete(storePath);
				try {
					await client.deleteFile(rel);
				} catch {
					// Already gone (rename race); reconcile heals the rest.
				}
			}
			return;
		}
		const digest = hashContent(node.content);
		if (this.lastPushed.get(storePath) === digest) return;
		if (typeof node.content === 'string') {
			await client.writeFile(rel, node.content);
		} else {
			await client.writeFile(rel, new Uint8Array(node.content));
		}
		this.lastPushed.set(storePath, digest);
	}

	/**
	 * Immediate full reconcile: flush debounced editor syncs, pull tool-owned
	 * files, push new/changed/deleted files, drop orphans. Called before every
	 * compile and by `flush()`.
	 */
	async reconcile(): Promise<void> {
		const client = this.client;
		if (!client || !this.projectId || this.status.kind !== 'ready') return;
		if (this.reconcileTimer !== null) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = null;
		}
		for (const [path, timer] of this.pushTimers) {
			clearTimeout(timer);
			this.pushTimers.delete(path);
		}
		await documentFileSyncService.flushAll();
		this.muted++;
		try {
			await this.pullToolOwned(client);
			const all = await fileStoreService.getAllFiles(true, false, false);
			const live = new Map(
				all
					.filter((f) => f.type === 'file' && !f.isDeleted && !isUktubToolOwned(f.path))
					.map((f) => [f.path, f] as const),
			);
			for (const [path, node] of live) {
				if (node.content === undefined) continue;
				const digest = hashContent(node.content);
				if (this.lastPushed.get(path) === digest) continue;
				const rel = toUktubRel(path);
				if (typeof node.content === 'string') {
					await client.writeFile(rel, node.content);
				} else {
					await client.writeFile(rel, new Uint8Array(node.content));
				}
				this.lastPushed.set(path, digest);
			}
			for (const path of [...this.lastPushed.keys()]) {
				if (!live.has(path)) {
					this.lastPushed.delete(path);
					try {
						await client.deleteFile(toUktubRel(path));
					} catch {
						// Gone already; state now matches.
					}
				}
			}
			// Orphans: in `/proj` but in neither the live set nor tool-owned.
			// Phase 9d D2: a `/proj` file the view never had (an agent `write`
			// whose view refresh lagged a parallel compile's flush) is pulled
			// INTO the view, never deleted. Deletions of files the view knew
			// stay handled by the existing `lastPushed` loop above.
			const liveRels = new Set(
				[...live.keys()].map((p) => toUktubRel(p)),
			);
			const { files } = await client.listFiles();
			const pulled: string[] = [];
			for (const f of files) {
				if (liveRels.has(f.path) || isUktubToolOwned(f.path)) continue;
				if (await this.pullIntoView(client, f.path)) pulled.push(f.path);
			}
			if (pulled.length > 0) this.pulledDuringReconcile.push(...pulled);
			} finally {
			this.muted--;
			}
			if (this.pulledDuringReconcile.length > 0) {
			const announced = [...new Set(this.pulledDuringReconcile)];
			this.pulledDuringReconcile = [];
			fileStorageEventEmitter.emitChange();
			emitAgentFilesChanged(announced);
			}
			}

	/** Re-import tool-owned files changed outside the UI (registry renders). */
	private async pullToolOwned(client: UktubBrowserClient): Promise<void> {
		let bib: { text?: string; base64?: string } | null = null;
		try {
			bib = await client.readFile(UKTUB_BIB);
		} catch {
			return; // Not rendered yet; nothing to pull.
		}
		const content = bib.text ?? '';
		const storePath = toStorePath(UKTUB_BIB);
		const node = await fileStoreService.getFileByPath(storePath, true);
		if (!node || node.type !== 'file') return;
		if (typeof node.content === 'string' && node.content === content) return;
		await fileStoreService.updateFileContent(node.id, content);
	}

	/**
	 * Pull one `/proj` file into the FileStore view (creating missing parent
	 * dirs, updating an existing node, tracking `lastPushed`). Returns false
	 * when the file is unreadable (deleted mid-run, binary decode).
	 */
	private async pullIntoView(client: UktubBrowserClient, rel: string): Promise<boolean> {
		try {
			const storePath = toStorePath(rel);
			const existing = await fileStoreService.getFileByPath(storePath, true);
			if (isBinaryFile(rel)) {
				const read = await client.readFile(rel, 'base64');
				if (read.base64 === undefined) return false;
				const content = base64ToArrayBuffer(read.base64);
				if (existing && existing.type === 'file') {
					await fileStoreService.updateFileContent(existing.id, content);
				} else {
					await this.storeNewAgentFile(storePath, rel, content, read.bytes);
				}
				this.lastPushed.set(storePath, hashContent(content));
			} else {
				const read = await client.readFile(rel);
				const content = read.text ?? '';
				if (existing && existing.type === 'file') {
					if (existing.content !== content) {
						await fileStoreService.updateFileContent(existing.id, content);
					}
				} else {
					await this.storeNewAgentFile(storePath, rel, content, read.bytes);
				}
				this.lastPushed.set(storePath, hashContent(content));
			}
			return true;
		} catch {
			// Unreadable (deleted mid-run, binary decode); skip it.
			return false;
		}
	}

	/**
	 * Refresh the FileStore view after the agent changed project files: for
	 * each project-relative path, re-import `/proj` bytes into the store
	 * (updating open files, creating new ones with their parent dirs, and
	 * pulling the tool-owned bibliography when the registry rendered it),
	 * then announce the changed files so open editors show the new content.
	 * Never throws: one unreadable file skips without blocking the rest.
	 */
	async refreshAgentPaths(rels: string[]): Promise<void> {
		const client = this.client;
		if (!client || !this.projectId || this.status.kind !== 'ready') return;
		const wanted = [...new Set(rels.map((r) => toUktubRel(r)))].filter(
			(r) => r !== '' && !isUktubToolOwned(r),
		);
		const changed: string[] = [];
		this.muted++;
		try {
			if (rels.map((r) => toUktubRel(r)).includes(UKTUB_BIB)) {
				await this.pullToolOwned(client);
				changed.push(UKTUB_BIB);
			}
			for (const rel of wanted) {
				if (await this.pullIntoView(client, rel)) changed.push(rel);
			}
			} finally {
			this.muted--;
			}
		fileStorageEventEmitter.emitChange();
		emitAgentFilesChanged(changed);
	}

	/** Store an agent-created file (and any missing parent dirs) in the view. */
	private async storeNewAgentFile(
		storePath: string,
		rel: string,
		content: string | ArrayBuffer,
		size: number,
	): Promise<void> {
		const nodes: FileNode[] = [];
		const now = Date.now();
		for (const dirPath of parentDirsOf(storePath)) {
			const dir = await fileStoreService.getFileByPath(dirPath, true);
			if (!dir) {
				nodes.push({
					id: nanoid(),
					name: baseNameOf(dirPath),
					path: dirPath,
					type: 'directory',
					lastModified: now,
				});
			}
		}
		nodes.push({
			id: nanoid(),
			name: baseNameOf(storePath),
			path: storePath,
			type: 'file',
			content,
			isBinary: typeof content !== 'string',
			mimeType: getMimeType(rel),
			lastModified: now,
			size,
		});
		if (nodes.length > 0) {
			await fileStoreService.batchStoreFiles(nodes, {
				showConflictDialog: false,
				preserveTimestamp: true,
				preserveDeletionStatus: true,
			});
		}
	}

	/** Flush pending writes now (pre-compile, tab hide). Never throws. */
	async flush(): Promise<void> {
		try {
			await this.reconcile();
		} catch (error) {
			console.warn('[uktub] flush failed:', error);
		}
	}

	/**
	 * Delete a TeXlyre project's Uktub storage (its own OPFS-backed pool,
	 * registry and files) through an ephemeral worker. Closes the live
	 * bridge first when it holds this project. Throws while another tab
	 * holds the project open (callers treat that as best-effort: the
	 * orphaned storage goes away on the next delete retry).
	 */
	async deleteProjectStorage(texlyreProjectId: string): Promise<void> {
		if (this.client && this.projectId === texlyreProjectId) await this.close();
		const base = import.meta.env.BASE_URL || '/';
		const workerUrl = `${base.replace(/\/$/, '')}/uktub/worker.js`;
		const worker = new Worker(workerUrl, { type: 'module' });
		const client = new UktubBrowserClient(worker);
		try {
			await client.ready;
			await client.deleteProjectStorage(texlyreProjectId);
			await client.close();
		} finally {
			client.terminate();
		}
	}

	/**
	 * Export one project's Uktub state (`/proj` files zip + registry DB
	 * bytes) for a backup archive. Uses the live bridge (after `flush()`)
	 * when that project is the one open in this tab, otherwise an ephemeral
	 * worker (init with that project id → export → close → terminate,
	 * exactly like `deleteProjectStorage`). Throws naming the refusal when
	 * the project is open in another tab; a null registry also throws —
	 * backups must never silently lack a project's registry.
	 */
	async exportUktubPayload(
		texlyreProjectId: string,
	): Promise<{ zip: Uint8Array; registry: Uint8Array | null }> {
		if (this.client && this.projectId === texlyreProjectId) {
			await this.flush();
			return await this.client.exportProject();
		}
		const client = await this.openEphemeral(texlyreProjectId);
		try {
			return await client.exportProject();
		} finally {
			await this.closeEphemeral(client);
		}
	}

	/**
	 * Import a worker export into a project's Uktub storage through an
	 * ephemeral worker (the target is never the open project at import
	 * time). The caller owns the resulting FileStore view, if any.
	 */
	async importUktubPayload(
		texlyreProjectId: string,
		payload: { zip?: Uint8Array; registry?: Uint8Array | null },
	): Promise<{ filesImported: number; registryImported: boolean }> {
		const client = await this.openEphemeral(texlyreProjectId);
		try {
			const res = await client.importProject(payload);
			return {
				filesImported: res.filesImported,
				registryImported: res.registryImported,
			};
		} finally {
			await this.closeEphemeral(client);
		}
	}

	/** Init an ephemeral worker holding one project (throws on lock refusal). */
	private async openEphemeral(
		texlyreProjectId: string,
	): Promise<UktubBrowserClient> {
		const base = import.meta.env.BASE_URL || '/';
		const workerUrl = `${base.replace(/\/$/, '')}/uktub/worker.js`;
		const worker = new Worker(workerUrl, { type: 'module' });
		const client = new UktubBrowserClient(worker);
		try {
			await client.ready;
			const res = (await client.init({
				projectId: texlyreProjectId,
			})) as unknown as { ok: boolean; reason?: string };
			if (!res || res.ok !== true) {
				throw new UktubLockError(
					(res as { reason?: string } | null)?.reason ?? 'refused',
				);
			}
			return client;
		} catch (error) {
			client.terminate();
			throw error;
		}
	}

	private async closeEphemeral(client: UktubBrowserClient): Promise<void> {
		try {
			await client.close();
		} catch {
			// Crash or wedge: terminate below regardless.
		}
		client.terminate();
	}

	/**
	 * Export the open project's Uktub state through the worker: the visible
	 * `/proj` files as a zip plus the standalone registry database bytes.
	 * Unlike TeXlyre's own export (its IndexedDB file-store view only), this
	 * keeps `.registry/registry.db`, `refs/references.bib`, sections and
	 * results, so an export → delete → import round trip restores papers.
	 */
	async exportProject(): Promise<{ zip: Uint8Array; registry: Uint8Array | null }> {
		const client = this.requireClient();
		await this.flush();
		const exported = await client.exportProject();
		return { zip: exported.zip, registry: exported.registry };
	}

	/**
	 * Import a worker export (`exportProject` above) into the open project,
	 * then rebuild the FileStore view so the editor, registry and
	 * bibliography reappear. Registry bytes are schema-verified by the
	 * worker; a bad payload leaves the previous registry untouched.
	 */
	async importProject(args: {
		zip?: Uint8Array;
		registry?: Uint8Array | null;
		replace?: boolean;
	}): Promise<{ filesImported: number; registryImported: boolean }> {
		const client = this.requireClient();
		const res = await client.importProject(args);
		await this.syncDownToStore();
		return { filesImported: res.filesImported, registryImported: res.registryImported };
	}

	async close(): Promise<void> {
		for (const [, timer] of this.pushTimers) clearTimeout(timer);
		this.pushTimers.clear();
		if (this.reconcileTimer !== null) {
			clearTimeout(this.reconcileTimer);
			this.reconcileTimer = null;
		}
		const client = this.client;
		this.client = null;
		this.projectId = null;
		this.lastPushed.clear();
		if (client) {
			try {
				await client.close();
			} catch {
				// Crash or wedge: terminate below regardless.
			}
			client.terminate();
		}
		if (this.worker) {
			try {
				this.worker.terminate();
			} catch {
				// Already gone.
			}
			this.worker = null;
		}
		this.setStatus('idle', null);
	}

	private requireClient(): UktubBrowserClient {
		if (!this.client) throw new Error('Uktub project is not open');
		return this.client;
	}

	private ensureUnloadHook(): void {
		if (this.unloadHookInstalled || typeof window === 'undefined') return;
		this.unloadHookInstalled = true;
		window.addEventListener('pagehide', () => {
			void this.close();
		});
	}
}

export const uktubProjectService = new UktubProjectService();
