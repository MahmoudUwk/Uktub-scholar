// src/services/CollabService.ts
import { IndexeddbPersistence } from 'y-indexeddb';
import type { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';

import { createNamedLogger } from '@/logging';
import type { User } from '../types/auth';
import type { CollabConnectOptions } from '../types/collab';
import type { YjsDocUrl } from '../types/yjs';
import { parseUrlFragments } from '../utils/urlUtils';
import { offlineService } from './OfflineService';

const moduleLog = createNamedLogger('CollabService');

interface LocalDocContainer {
	doc: Y.Doc;
	persistence: IndexeddbPersistence;
	provider: null;
	refCount: number;
	isOffline: true;
}

class CollabService {
	private docContainers: Map<string, LocalDocContainer> = new Map();
	private offlineStatusUnsubscribe: (() => void) | null = null;

	constructor() {
		this.offlineStatusUnsubscribe = offlineService.addStatusListener(
			(status) => {
				this.handleNetworkChange(status.isOnline);
			},
		);
	}

	private isOfflineMode(): boolean {
		return !offlineService.getStatus().isOnline;
	}

	public connect(
		docId: string,
		collectionName: string,
		options?: CollabConnectOptions,
	): { doc: Y.Doc; provider: null } {
		void options;
		const containerId = `${docId}-${collectionName}`;

		if (this.docContainers.has(containerId)) {
			const container = this.docContainers.get(containerId)!;
			container.refCount++;
			return {
				doc: container.doc,
				provider: null,
			};
		}

		moduleLog.info(`Creating new local connection for: ${containerId}`);

		// Single local user: always use the local Yjs document persisted to
		// IndexedDB. No WebRTC/WebSocket providers, no signaling servers.
		return this.createOfflineConnection(docId, collectionName, containerId);
	}

	private createOfflineConnection(
		docId: string,
		collectionName: string,
		containerId: string,
	): { doc: Y.Doc; provider: null } {
		const doc = new Y.Doc();
		const dbName = `texlyre-project-${docId}`;
		const persistenceName = `${dbName}-${collectionName}`;

		const persistence = new IndexeddbPersistence(persistenceName, doc);

		const offlineContainer: LocalDocContainer = {
			doc,
			persistence,
			provider: null,
			refCount: 1,
			isOffline: true,
		};

		this.docContainers.set(containerId, offlineContainer);
		moduleLog.info(`Created offline connection for: ${containerId}`);

		return { doc, provider: null };
	}

	public setUserInfo(docId: string, collectionName: string, user: User): void {
		const containerId = `${docId}-${collectionName}`;
		const container = this.docContainers.get(containerId);

		if (container) {
			// Local-only mode: no shared awareness; nothing to publish.
			moduleLog.info(
				'Skipping user awareness in local-only mode for:',
				user.username,
			);
		}
	}

	public disconnect(docId: string, collectionName: string): void {
		const containerId = `${docId}-${collectionName}`;
		if (!this.docContainers.has(containerId)) {
			return;
		}

		const container = this.docContainers.get(containerId)!;
		container.refCount--;

		if (container.refCount <= 0) {
			moduleLog.info(`Destroying connection for: ${containerId}`);

			container.persistence.destroy();
			container.doc.destroy();
			this.docContainers.delete(containerId);
		}
	}

	public getAwareness(
		_docId: string,
		_collectionName: string,
	): Awareness | null {
		// Local-only mode: no shared awareness.
		return null;
	}

	public getDocContainer(
		docId: string,
		collectionName: string,
	): LocalDocContainer | undefined {
		const containerId = `${docId}-${collectionName}`;
		return this.docContainers.get(containerId);
	}

	public isConnectionOnline(_docId: string, _collectionName: string): boolean {
		// Local-only mode: never connected to a remote provider.
		return false;
	}

	public async getDocumentMetadata(
		url: YjsDocUrl,
	): Promise<{ name: string; description: string; type: string } | null> {
		const fragments = parseUrlFragments(url);
		const yjsUrl = fragments.yjsUrl;

		const projectId = yjsUrl.startsWith('yjs:')
			? yjsUrl.slice(4)
			: yjsUrl.replace(/[^a-zA-Z0-9]/g, '-');

		const doc = new Y.Doc();
		const persistenceName = `texlyre-project-${projectId}-yjs_metadata`;
		const persistence = new IndexeddbPersistence(persistenceName, doc);

		try {
			await new Promise<void>((resolve) => {
				persistence.once('synced', () => {
					resolve();
				});
				setTimeout(resolve, 1000);
			});

			const ymap = doc.getMap('data');
			const docData = ymap.toJSON();

			return (docData?.projectMetadata as any) ?? null;
		} catch (error) {
			moduleLog.error('Error checking document metadata:', error);
			return null;
		} finally {
			persistence.destroy();
			doc.destroy();
		}
	}

	private syncConnections: Map<
		string,
		{
			connections: Array<{ docId: string; collectionName: string }>;
			timeoutId: ReturnType<typeof setTimeout>;
		}
	> = new Map();

	public async syncAllDocuments(
		projectId: string,
		onProgress?: (current: number, total: number) => void,
		collabOptions?: CollabConnectOptions,
	): Promise<string> {
		moduleLog.info(
			`Starting bulk sync for project: ${projectId} (offline: ${this.isOfflineMode()})`,
		);

		if (this.isOfflineMode()) {
			moduleLog.info('Offline mode detected - local sync only');
			onProgress?.(0, 0);
			return 'offline-sync';
		}

		try {
			const metadataCollection = `texlyre-project-${projectId}-yjs_metadata`;
			const metadataDoc = new Y.Doc();
			const metadataPersistence = new IndexeddbPersistence(
				metadataCollection,
				metadataDoc,
			);

			await new Promise<void>((resolve) => {
				const timeout = setTimeout(() => resolve(), 2000);
				metadataPersistence.once('synced', () => {
					clearTimeout(timeout);
					resolve();
				});
			});

			const dataMap = metadataDoc.getMap('data');
			const documents = dataMap.get('documents') || [];

			metadataPersistence.destroy();
			metadataDoc.destroy();

			if (!Array.isArray(documents) || documents.length === 0) {
				moduleLog.info(`No documents found for project: ${projectId}`);
				onProgress?.(0, 0);
				return '';
			}

			const documentsToSync = documents.filter((doc) => {
				const collectionName = `yjs_${doc.id}`;
				const containerId = `${projectId}-${collectionName}`;
				const isCurrentlyConnected = this.docContainers.has(containerId);

				if (isCurrentlyConnected) {
					moduleLog.info(
						`Skipping document ${doc.name} (currently open for editing)`,
					);
				}

				return !isCurrentlyConnected;
			});

			moduleLog.info(
				`Opening ${documentsToSync.length} documents for sync (${documents.length} total, ${documents.length - documentsToSync.length} currently being edited)`,
			);
			onProgress?.(0, documentsToSync.length);

			const connections: Array<{ docId: string; collectionName: string }> = [];

			for (const doc of documentsToSync) {
				const collectionName = `yjs_${doc.id}`;

				try {
					moduleLog.info(`Connecting to document: ${doc.name}`);
					this.connect(projectId, collectionName, collabOptions);
					connections.push({ docId: projectId, collectionName });
				} catch (error) {
					moduleLog.error(`Error connecting to document ${doc.name}:`, error);
				}
			}

			onProgress?.(documentsToSync.length, documentsToSync.length);
			moduleLog.info(
				`All ${connections.length} documents opened locally for sync.`,
			);

			const syncId = `sync-${projectId}-${Date.now()}`;
			const timeoutId = setTimeout(() => {
				this.stopSyncAllDocuments(syncId);
			}, 60000);

			this.syncConnections.set(syncId, { connections, timeoutId });

			moduleLog.info(
				`Sync session ${syncId} active. All documents will auto-disconnect in 60 seconds.`,
			);
			return syncId;
		} catch (error) {
			moduleLog.error('Error during bulk sync:', error);
			throw error;
		}
	}

	public stopSyncAllDocuments(syncId: string): void {
		if (syncId === 'offline-sync') {
			moduleLog.info('Offline sync session - no connections to stop');
			return;
		}

		const syncSession = this.syncConnections.get(syncId);
		if (!syncSession) {
			moduleLog.info(`Sync session ${syncId} not found or already stopped`);
			return;
		}

		moduleLog.info(
			`Stopping sync session ${syncId}, disconnecting ${syncSession.connections.length} documents`,
		);

		clearTimeout(syncSession.timeoutId);

		for (const connection of syncSession.connections) {
			try {
				this.disconnect(connection.docId, connection.collectionName);
			} catch (error) {
				moduleLog.error(
					`Error disconnecting ${connection.collectionName}:`,
					error,
				);
			}
		}

		this.syncConnections.delete(syncId);
		moduleLog.info(`Sync session ${syncId} stopped successfully`);
	}

	public getSyncSessions(): string[] {
		return Array.from(this.syncConnections.keys());
	}

	public getConnectionStatus(): {
		isOnline: boolean;
		hasActiveConnections: boolean;
	} {
		const status = offlineService.getStatus();
		const hasActiveConnections = this.docContainers.size > 0;
		return {
			isOnline: status.isOnline,
			hasActiveConnections,
		};
	}

	public async getDocumentContent(
		projectUrl: YjsDocUrl,
		documentId: string,
	): Promise<string> {
		const projectId = projectUrl.startsWith('yjs:')
			? projectUrl.slice(4)
			: projectUrl;
		const dbName = `texlyre-project-${projectId}`;
		const collectionName = `${dbName}-yjs_${documentId}`;
		const doc = new Y.Doc();
		const persistence = new IndexeddbPersistence(collectionName, doc);

		try {
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, 2000);
				persistence.once('synced', () => {
					clearTimeout(timeout);
					resolve();
				});
			});

			return doc.getText('codemirror').toString();
		} catch (error) {
			moduleLog.error('Error getting document content:', error);
			return '';
		} finally {
			persistence.destroy();
			doc.destroy();
		}
	}

	public async updateDocumentContent(
		projectId: string,
		documentId: string,
		updater: (currentContent: string) => string,
	): Promise<void> {
		const collectionName = `yjs_${documentId}`;
		const containerId = `${projectId}-${collectionName}`;

		const wasConnected = this.docContainers.has(containerId);
		let container: LocalDocContainer | undefined;

		if (!wasConnected) {
			const { provider } = this.connect(projectId, collectionName);
			container = this.getDocContainer(projectId, collectionName);

			const persistence = container?.persistence;
			if (persistence) {
				await new Promise<void>((resolve) => {
					const timeout = setTimeout(resolve, 2000);

					const handleSynced = () => {
						clearTimeout(timeout);
						persistence.off('synced', handleSynced);
						resolve();
					};

					persistence.on('synced', handleSynced);

					if (persistence.synced) {
						clearTimeout(timeout);
						persistence.off('synced', handleSynced);
						resolve();
					}
				});
			}

			if (provider && !this.isOfflineMode()) {
				await new Promise((resolve) => setTimeout(resolve, 500));
			}
		} else {
			container = this.getDocContainer(projectId, collectionName);
		}

		if (!container) throw new Error('Could not access document');

		const ytext = container.doc.getText('codemirror');
		const currentContent = ytext.toString();
		const newContent = updater(currentContent);

		container.doc.transact(() => {
			ytext.delete(0, ytext.length);
			ytext.insert(0, newContent);
		});

		if (!wasConnected) {
			await new Promise((resolve) => setTimeout(resolve, 500));
			this.disconnect(projectId, collectionName);
		}
	}

	// Local-only mode: documents are never synced to a remote provider.
	private handleNetworkChange(isOnline: boolean): void {
		moduleLog.info(
			`Network status changed: ${isOnline ? 'online' : 'offline'}`,
		);

		if (!isOnline) {
			moduleLog.info('Network offline - collaboration features disabled');
		} else {
			moduleLog.info('Network online - collaboration features enabled');
		}
	}

	public disconnectAll(docId: string): void {
		const prefix = `${docId}-`;
		for (const containerId of Array.from(this.docContainers.keys())) {
			if (!containerId.startsWith(prefix)) continue;
			const container = this.docContainers.get(containerId);
			if (container) {
				container.refCount = 1;
				this.disconnect(docId, containerId.slice(prefix.length));
			}
		}
	}

	public cleanup(): void {
		if (this.offlineStatusUnsubscribe) {
			this.offlineStatusUnsubscribe();
			this.offlineStatusUnsubscribe = null;
		}
	}
}

export const collabService = new CollabService();
