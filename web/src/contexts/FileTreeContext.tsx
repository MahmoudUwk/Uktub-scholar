// src/contexts/FileTreeContext.tsx
import { nanoid } from 'nanoid';
import type React from 'react';
import {
	type ReactNode,
	createContext,
	useCallback,
	useEffect,
	useRef,
	useState,
} from 'react';

import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import { useCollab } from '../hooks/useCollab';
import { useSettings } from '../hooks/useSettings';
import { autoSaveService } from '../services/AutoSaveService';
import { collabService } from '../services/CollabService';
import { fileConflictPromptService } from '../services/FileConflictPromptService';
import { fileOperationNotificationService } from '../services/FileOperationNotificationService';
import { fileStoreService } from '../services/FileStoreService';
import type { DocumentList } from '../types/documents';
import type { FileNode, FileTreeContextType } from '../types/files';
import type { YjsDocUrl } from '../types/yjs';
import { duplicateKeyDetectionService } from '../services/DuplicateKeyDetectionService';
import {
	UKTUB_TOOL_OWNED_NOTE,
	isUktubProtectedPath,
	isUktubToolOwned,
} from '../services/uktubPaths';
import {
	UktubLockError,
	uktubProjectService,
	type UktubStatus,
} from '../services/UktubProjectService';
import {
	getMimeType,
	isBinaryFile,
	isTemporaryFile,
	stringToArrayBuffer,
} from '../utils/fileUtils';
import { batchExtractArchive } from '../utils/archiveUtils';

const moduleLog = createNamedLogger('FileTreeContext');

const refuseIfUktubProtected = (storePath: string): void => {
	if (isUktubProtectedPath(storePath)) {
		throw new Error(UKTUB_TOOL_OWNED_NOTE);
	}
};

export const FileTreeContext = createContext<FileTreeContextType | null>(null);

interface FileTreeProviderProps {
	children: ReactNode;
	docUrl: YjsDocUrl;
}

export const FileTreeProvider: React.FC<FileTreeProviderProps> = ({
	children,
	docUrl,
}) => {
	const { data: doc, changeData: changeDoc } = useCollab<DocumentList>();
	const { getSetting } = useSettings();
	const [fileTree, setFileTree] = useState<FileNode[]>([]);
	const [selectedFileId, setSelectedFileId] = useState<string | null>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [uktubStatus, setUktubStatus] = useState<UktubStatus>(() =>
		uktubProjectService.getStatus(),
	);
	const storageInitialized = useRef(false);

	const enableFileSystemDragDrop =
		(getSetting('file-tree-filesystem-drag-drop')?.value as boolean) ?? true;
	const enableInternalDragDrop =
		(getSetting('file-tree-internal-drag-drop')?.value as boolean) ?? true;

	useEffect(() => {
		// This starts duplicate detection when file tree is loaded to avoid idb conflicts storing with same key
		if (!isLoading && fileTree.length > 0) {
			duplicateKeyDetectionService.start();
		}

		return () => {
			duplicateKeyDetectionService.stop();
		};
	}, [isLoading, fileTree]);

	useEffect(() => {
		return uktubProjectService.subscribe(setUktubStatus);
	}, []);

	useEffect(() => {
		if (!storageInitialized.current && docUrl) {
			const initFileStorage = async () => {
				try {
					// Uktub `/proj` owns every project file: open the worker
					// first (lock refusal surfaces as a notice, not corruption),
					// then rebuild the IndexedDB view from it.
					const projectId = docUrl.startsWith('yjs:')
						? docUrl.slice(4)
						: docUrl.replace(/[^a-zA-Z0-9]/g, '-');
					await fileStoreService.initialize(docUrl);
					await uktubProjectService.openProject(projectId);
					storageInitialized.current = true;
					const tree = await fileStoreService.buildFileTree();
					setFileTree(tree);
					setIsLoading(false);
				} catch (error) {
					if (error instanceof UktubLockError) {
						moduleLog.warn('Uktub project unavailable:', error.message);
					} else {
						moduleLog.error('Failed to initialize file storage:', error);
					}
					setIsLoading(false);
				}
			};
			initFileStorage();
		}
	}, [docUrl]);

	const refreshFileTree = useCallback(async () => {
		try {
			const tree = await fileStoreService.buildFileTree();
			setFileTree(tree);
			return tree;
		} catch (error) {
			moduleLog.error('Error refreshing file tree:', error);
			return [];
		}
	}, []);

	const selectFile = useCallback((fileId: string | null) => {
		setSelectedFileId(fileId);
	}, []);

	const uploadFiles = useCallback(
		async (
			files: FileList | File[],
			currentPath: string,
			targetDirectoryId?: string,
		) => {
			setIsLoading(true);
			let targetPath = currentPath;
			try {
				if (targetDirectoryId) {
					const targetDir = await fileStoreService.getFile(targetDirectoryId);
					if (targetDir && targetDir.type === 'directory') {
						targetPath = targetDir.path;
					}
				}

				const filesToProcess: FileNode[] = [];
				const skippedOwned: string[] = [];

				for (let i = 0; i < files.length; i++) {
					const file = files[i];
					const filePath =
						targetPath === '/' ? `/${file.name}` : `${targetPath}/${file.name}`;
					// Tool-owned files (registry-rendered) are read-only in the UI.
					if (isUktubToolOwned(filePath)) {
						skippedOwned.push(file.name);
						continue;
					}
					const fileContent = await file.arrayBuffer();
					const mimeType = getMimeType(file.name);
					const binary = isBinaryFile(file.name);
					const rawFile: FileNode = {
						id: nanoid(),
						name: file.name,
						path: filePath,
						type: 'file',
						content: fileContent,
						lastModified: file.lastModified,
						size: file.size,
						mimeType,
						isBinary: binary,
					};
					filesToProcess.push(rawFile);
				}

				try {
					await fileStoreService.batchStoreFiles(filesToProcess);
				} catch (error) {
					if (
						error instanceof Error &&
						error.message === t('File operation cancelled by user')
					) {
						return;
					}
					throw error;
				}

				await refreshFileTree();
				if (skippedOwned.length > 0) {
					fileOperationNotificationService.showError(
						`upload-owned-${Date.now()}`,
						`${UKTUB_TOOL_OWNED_NOTE} (${t('Skipped')}: ${skippedOwned.join(', ')})`,
					);
				}
			} catch (error) {
				moduleLog.error('Error uploading files:', error);
			} finally {
				setIsLoading(false);
			}
		},
		[refreshFileTree],
	);

	const extractArchiveFile = useCallback(
		async (zipFile: File, targetPath: string) => {
			const operationId = `extract-${Date.now()}`;

			try {
				fileOperationNotificationService.showLoading(
					operationId,
					t('Extracting {fileName}...', {
						fileName: zipFile.name,
					}),
				);

				const { files: extractedFiles, directories } =
					await batchExtractArchive(zipFile, targetPath);

				fileOperationNotificationService.updateProgress(
					operationId,
					t('Processing {count} files...', {
						count: extractedFiles.length,
					}),
				);

				const allFiles = [...directories, ...extractedFiles];
				// Tool-owned files (registry-rendered) are read-only in the UI.
				const storable = allFiles.filter(
					(f) => f.type !== 'file' || !isUktubToolOwned(f.path),
				);
				await fileStoreService.batchStoreFiles(storable);

				fileOperationNotificationService.showSuccess(
					operationId,
					t('Successfully extracted {count} files', {
						count: extractedFiles.length,
					}),
				);

				await refreshFileTree();
			} catch (error) {
				fileOperationNotificationService.showError(
					operationId,
					t('Failed to extract ZIP: {error}', {
						error: error instanceof Error ? error.message : String(error),
					}),
				);
				throw error;
			}
		},
		[refreshFileTree],
	);

	const storeZipFile = useCallback(
		async (zipFile: File, targetPath: string) => {
			try {
				const filePath =
					targetPath === '/'
						? `/${zipFile.name}`
						: `${targetPath}/${zipFile.name}`;
				refuseIfUktubProtected(filePath);
				const fileContent = await zipFile.arrayBuffer();
				const mimeType = 'application/zip';

				const rawFile: FileNode = {
					id: nanoid(),
					name: zipFile.name,
					path: filePath,
					type: 'file',
					content: fileContent,
					lastModified: zipFile.lastModified,
					size: zipFile.size,
					mimeType,
					isBinary: true,
				};

				await fileStoreService.storeFile(rawFile);
				await refreshFileTree();
			} catch (error) {
				if (
					error instanceof Error &&
					error.message !== t('File operation cancelled by user')
				) {
					moduleLog.error('Failed to store ZIP file:', error);
					throw error;
				}
			}
		},
		[refreshFileTree],
	);

	const setupFileSyncListener = useCallback(
		(documentId: string, fileId: string) => {
			const mapping = { documentId, fileId };
			const mappingKey = `file-sync-${documentId}`;
			sessionStorage.setItem(mappingKey, JSON.stringify(mapping));
		},
		[],
	);

	const linkFileToDocument = useCallback(
		async (fileId: string, documentId?: string) => {
			if (uktubStatus.kind !== 'ready' && uktubStatus.kind !== 'opening') {
				return;
			}
			try {
				if (!fileStoreService.db) await fileStoreService.initialize(docUrl);
				const file = await fileStoreService.getFile(fileId);
				if (file && isUktubToolOwned(file.path)) {
					throw new Error(UKTUB_TOOL_OWNED_NOTE);
				}
				if (file && changeDoc && doc) {
					const linkConfirmation =
						await fileConflictPromptService.confirmLink(file);

					if (linkConfirmation === 'cancel') {
						return;
					}

					const shouldCopyContent = linkConfirmation === 'link-with-copy';
					let textContent = '';

					if (shouldCopyContent) {
						const fileContent = await fileStoreService.getFile(fileId);
						if (fileContent?.content instanceof ArrayBuffer) {
							textContent = new TextDecoder().decode(fileContent.content);
						} else if (typeof fileContent?.content === 'string') {
							textContent = fileContent.content;
						}
					} else {
						file.content = stringToArrayBuffer('');
						await fileStoreService.storeFile(file, {
							showConflictDialog: false,
						});
					}

					let createdDocId: string | null = null;

					changeDoc((d) => {
						const docIndex =
							d.documents?.findIndex((doc) => doc.name === file.path) ?? -1;
						if (docIndex >= 0) {
							d.currentDocId = d.documents[docIndex].id;
							createdDocId = d.documents[docIndex].id;
						} else {
							if (!d.documents) d.documents = [];
							const newDocId = Math.random().toString(36).substring(2, 15);
							d.documents.push({
								id: newDocId,
								name: file.path,
								content: '',
								createdAt: Date.now(),
							});
							d.currentDocId = newDocId;
							createdDocId = newDocId;
						}
					});

					file.documentId = documentId ?? createdDocId ?? undefined;
					await fileStoreService.storeFile(file, {
						showConflictDialog: false,
					});

					if (createdDocId && shouldCopyContent && textContent) {
						const projectId = docUrl.startsWith('yjs:')
							? docUrl.slice(4)
							: docUrl;
						const collectionName = `yjs_${createdDocId}`;

						const signalingServers =
							(getSetting('collab-signaling-servers')?.value as
								| string
								| undefined) ?? 'ws://ywebrtc.localhost:8082/';
						const awarenessTimeout =
							(getSetting('collab-awareness-timeout')?.value as
								| number
								| undefined) ?? 30;
						const autoReconnect =
							(getSetting('collab-auto-reconnect')?.value as
								| boolean
								| undefined) ?? false;

						const serversToUse = signalingServers
							.split(',')
							.map((s) => s.trim());

						const { doc: newYDoc } = collabService.connect(
							projectId,
							collectionName,
							{
								signalingServers: serversToUse,
								autoReconnect,
								awarenessTimeout: awarenessTimeout * 1000,
							},
						);

						const container = collabService.getDocContainer(
							projectId,
							collectionName,
						);
						if (container?.persistence) {
							await new Promise<void>((resolve) => {
								const timeout = setTimeout(resolve, 2000);
								if (container.persistence.synced) {
									clearTimeout(timeout);
									resolve();
									return;
								}
								container.persistence.once('synced', () => {
									clearTimeout(timeout);
									resolve();
								});
							});
						}

						newYDoc.transact(() => {
							const ytext = newYDoc.getText('codemirror');
							if (ytext.length === 0) {
								ytext.insert(0, textContent);
							}
						});

						await new Promise((resolve) => setTimeout(resolve, 500));
						collabService.disconnect(projectId, collectionName);

						setupFileSyncListener(createdDocId, fileId);
					}

					await refreshFileTree();
					if (createdDocId) {
						const event = new CustomEvent('document-linked', {
							detail: { documentId: createdDocId },
						});
						document.dispatchEvent(event);
					}
				}
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === t('Link operation cancelled by user')
				) {
					return;
				}
				moduleLog.error('Error linking file to document:', error);
			}
		},
		[
			changeDoc,
			doc,
			refreshFileTree,
			docUrl,
			setupFileSyncListener,
			getSetting,
			uktubStatus,
		],
	);

	const unlinkFileFromDocument = useCallback(
		async (fileId: string) => {
			if (uktubStatus.kind !== 'ready' && uktubStatus.kind !== 'opening') {
				return;
			}
			try {
				if (!fileStoreService.db) await fileStoreService.initialize(docUrl);
				const file = await fileStoreService.getFile(fileId);
				if (file?.documentId && changeDoc && doc) {
					const unlinkConfirmation =
						await fileConflictPromptService.confirmUnlink(file);

					if (unlinkConfirmation === 'cancel') {
						return;
					}

					file.documentId = undefined;
					await fileStoreService.storeFile(file, {
						showConflictDialog: false,
					});
					changeDoc((d) => {
						if (!d.documents) return;
						const docIndex = d.documents.findIndex(
							(doc) => doc.name === file.path,
						);
						if (docIndex >= 0) {
							d.documents.splice(docIndex, 1);
						}
					});
				}
				await refreshFileTree();
				window.location.reload();
			} catch (error) {
				if (
					error instanceof Error &&
					error.message === t('Unlink operation cancelled by user')
				) {
					return;
				}
				moduleLog.error('Error unlinking file from document:', error);
			}
		},
		[changeDoc, doc, refreshFileTree, uktubStatus, docUrl],
	);

	const createDirectory = useCallback(
		async (name: string, path: string) => {
			if (!name) return;
			try {
				const dirPath = path === '/' ? `/${name}` : `${path}/${name}`;
				refuseIfUktubProtected(dirPath);
				const directory: FileNode = {
					id: nanoid(),
					name,
					path: dirPath,
					type: 'directory',
					lastModified: Date.now(),
				};
				await fileStoreService.storeFile(directory);
				await refreshFileTree();
			} catch (error) {
				if (
					error instanceof Error &&
					error.message !== t('File operation cancelled by user')
				) {
					moduleLog.error('Error creating directory:', error);
				}
			}
		},
		[refreshFileTree],
	);

	const batchDeleteFiles = useCallback(
		async (fileIds: string[]) => {
			try {
				const allFiles = await fileStoreService.getAllFiles(
					false,
					false,
					false,
				);
				const filesToDelete = fileIds
					.map((id) => allFiles.find((f) => f.id === id))
					.filter(Boolean) as FileNode[];

				for (const file of filesToDelete) {
					refuseIfUktubProtected(file.path);
				}

				const hasTemporaryFiles = filesToDelete.some((file) =>
					isTemporaryFile(file.path),
				);

				const allFilesToDelete: string[] = [];

				for (const file of filesToDelete) {
					if (file.type === 'directory') {
						const linkedFilesInDirectory = allFiles.filter(
							(f) =>
								f.path.startsWith(file.path) &&
								f.path !== file.path &&
								f.documentId,
						);

						if (linkedFilesInDirectory.length > 0) {
							throw new Error(
								t(
									'Cannot delete directory containing linked files. Please unlink files first.',
								),
							);
						}

						const childrenToDelete = allFiles.filter(
							(f) => f.path.startsWith(file.path) && f.path !== file.path,
						);
						allFilesToDelete.push(...childrenToDelete.map((c) => c.id));
					}
					allFilesToDelete.push(file.id);
				}

				await fileStoreService.batchDeleteFiles(allFilesToDelete, {
					hardDelete: hasTemporaryFiles,
				});

				if (selectedFileId && allFilesToDelete.includes(selectedFileId)) {
					setSelectedFileId(null);
				}

				await refreshFileTree();
			} catch (error) {
				moduleLog.error('Error in batch delete:', error);
				if (error instanceof Error) {
					const operationId = `batch-delete-${Date.now()}`;
					fileOperationNotificationService.showError(
						operationId,
						t('Failed to delete files: {error}', {
							error: error instanceof Error ? error.message : String(error),
						}),
					);
				}
			}
		},
		[refreshFileTree, selectedFileId],
	);

	const batchMoveFiles = useCallback(
		async (
			moveOperations: Array<{
				fileId: string;
				targetPath: string;
				newName?: string;
			}>,
		) => {
			try {
				const operationId = `batch-move-${Date.now()}`;

				fileOperationNotificationService.showLoading(
					operationId,
					t('Moving {count} files...', {
						count: moveOperations.length,
					}),
				);

				await autoSaveService.flushPendingSaves();

				// Tool-owned files (registry-rendered) are read-only in the UI:
				// neither they nor their parent dirs move, and nothing takes
				// their path.
				const moveSources = await fileStoreService.getAllFiles(
					false,
					false,
					false,
				);
				for (const op of moveOperations) {
					const source = moveSources.find((f) => f.id === op.fileId);
					if (!source) continue;
					refuseIfUktubProtected(source.path);
					const destFull = op.targetPath.endsWith(`/${source.name}`)
						? op.targetPath
						: op.targetPath === '/'
							? `/${source.name}`
							: `${op.targetPath}/${source.name}`;
					if (isUktubToolOwned(destFull)) {
						throw new Error(UKTUB_TOOL_OWNED_NOTE);
					}
				}

				const movedIds = await fileStoreService.batchMoveFiles(moveOperations);

				fileOperationNotificationService.showSuccess(
					operationId,
					t('Successfully moved {count} files', {
						count: movedIds.length,
					}),
				);

				await refreshFileTree();
				return movedIds;
			} catch (error) {
				const operationId = `batch-move-${Date.now()}`;
				fileOperationNotificationService.showError(
					operationId,
					t('Failed to move files: {error}', {
						error: error instanceof Error ? error.message : String(error),
					}),
				);

				if (
					error instanceof Error &&
					error.message !== t('File operation cancelled by user')
				) {
					moduleLog.error('Error in batch move:', error);
				}
				throw error;
			}
		},
		[refreshFileTree],
	);

	const batchUnlinkFiles = useCallback(
		async (fileIds: string[]) => {
			try {
				const operationId = `batch-unlink-${Date.now()}`;

				fileOperationNotificationService.showLoading(
					operationId,
					t('Unlinking {count} files...', {
						count: fileIds.length,
					}),
				);

				await fileStoreService.batchUnlinkFiles(fileIds);

				if (changeDoc && doc) {
					const files = await Promise.all(
						fileIds.map((fileId) => fileStoreService.getFile(fileId)),
					);

					changeDoc((d) => {
						if (!d.documents) return;

						files.forEach((file) => {
							if (file) {
								const docIndex = d.documents?.findIndex(
									(doc) => doc.name === file.path,
								);
								if (docIndex >= 0) {
									d.documents?.splice(docIndex, 1);
								}
							}
						});
					});
				}

				fileOperationNotificationService.showSuccess(
					operationId,
					t('Successfully unlinked {count} files', {
						count: fileIds.length,
					}),
				);

				await refreshFileTree();
				window.location.reload();
			} catch (error) {
				const operationId = `batch-unlink-${Date.now()}`;
				fileOperationNotificationService.showError(
					operationId,
					t('Failed to unlink files: {error}', {
						error: error instanceof Error ? error.message : String(error),
					}),
				);

				if (
					error instanceof Error &&
					error.message !== t('Unlink operation cancelled by user')
				) {
					moduleLog.error('Error in batch unlink:', error);
				}
				throw error;
			}
		},
		[changeDoc, doc, refreshFileTree],
	);

	const deleteFileOrDirectory = useCallback(
		async (id: string) => {
			await batchDeleteFiles([id]);
		},
		[batchDeleteFiles],
	);

	const getFileContent = useCallback(async (fileId: string) => {
		// The bridge owns the view: when it is down (locked/other project/
		// closed), resolve empty instead of throwing into the console.
		if (uktubStatus.kind !== 'ready' && uktubStatus.kind !== 'opening') {
			return undefined;
		}
		try {
			const file = await fileStoreService.getFile(fileId);
			return file?.content;
		} catch (error) {
			moduleLog.error('Error getting file content:', error);
			return undefined;
		}
	}, [uktubStatus]);

	const getFile = useCallback(async (fileId: string) => {
		// Same bridge-down rule as getFileContent above.
		if (uktubStatus.kind !== 'ready' && uktubStatus.kind !== 'opening') {
			return undefined;
		}
		try {
			return await fileStoreService.getFile(fileId);
		} catch (error) {
			moduleLog.error('Error getting file:', error);
			return undefined;
		}
	}, [uktubStatus]);

	const moveFileOrDirectory = useCallback(
		async (sourceId: string, targetPath: string) => {
			try {
				const sourceFile = await fileStoreService.getFile(sourceId);
				if (!sourceFile) {
					moduleLog.error('Source file not found');
					return;
				}

				moduleLog.info(
					`Moving ${sourceFile.name} from ${sourceFile.path} to directory ${targetPath}`,
				);

				await autoSaveService.flushPendingSaves();

				const movedIds = await fileStoreService.batchMoveFiles([
					{
						fileId: sourceId,
						targetPath: targetPath,
					},
				]);

				moduleLog.info('Move completed, new IDs:', movedIds);
				await refreshFileTree();
			} catch (error) {
				moduleLog.error('Error in moveFileOrDirectory:', error);
				if (
					error instanceof Error &&
					error.message !== t('File operation cancelled by user')
				) {
					moduleLog.error('Error moving file or directory:', error);
				}
			}
		},
		[refreshFileTree],
	);

	const renameFile = useCallback(
		async (fileId: string, newFullPath: string) => {
			try {
				const originalFile = await fileStoreService.getFile(fileId);
				if (!originalFile) {
					throw new Error(t('Original file not found'));
				}

				const oldPath = originalFile.path;

				if (oldPath === newFullPath.trim()) {
					return fileId;
				}

				moduleLog.info(
					`Renaming ${originalFile.name} from ${oldPath} to ${newFullPath}`,
				);

				await autoSaveService.flushPendingSaves();

				const movedIds = await fileStoreService.batchMoveFiles(
					[
						{
							fileId,
							targetPath: newFullPath.trim(),
						},
					],

					{ showConflictDialog: true },
				);

				moduleLog.info('Rename completed, new IDs:', movedIds);

				if (movedIds.length === 0) {
					return fileId;
				}

				const newFileId = movedIds[0];

				if (selectedFileId === fileId) {
					setSelectedFileId(newFileId);
				}

				await refreshFileTree();
				return newFileId;
			} catch (error) {
				moduleLog.error('Error in renameFile:', error);
				if (
					error instanceof Error &&
					error.message === t('File operation cancelled by user')
				) {
					throw error;
				}
				moduleLog.error('Error renaming/moving file:', error);
				throw error;
			}
		},
		[refreshFileTree, selectedFileId],
	);

	const updateFileContent = useCallback(
		async (fileId: string, content: string) => {
			try {
				const file = await fileStoreService.getFile(fileId);
				if (file && isUktubToolOwned(file.path)) {
					throw new Error(UKTUB_TOOL_OWNED_NOTE);
				}
				const contentBuffer = stringToArrayBuffer(content);
				await fileStoreService.updateFileContent(fileId, contentBuffer);
			} catch (error) {
				moduleLog.error('Error updating file content:', error);
			}
			},
			[],
			);

	const clearSelectedFile = useCallback(() => {
		setSelectedFileId(null);
	}, []);

	const contextValue = {
		fileTree,
		selectedFileId,
		isLoading,
		selectFile,
		uploadFiles,
		createDirectory,
		deleteFileOrDirectory,
		linkFileToDocument,
		unlinkFileFromDocument,
		getFileContent,
		getFile,
		renameFile,
		updateFileContent,
		refreshFileTree,
		moveFileOrDirectory,
		extractArchiveFile,
		storeZipFile,
		enableFileSystemDragDrop,
		enableInternalDragDrop,
		batchDeleteFiles,
		batchMoveFiles,
		batchUnlinkFiles,
		clearSelectedFile,
		uktubStatus,
	};

	return (
		<FileTreeContext.Provider value={contextValue}>
			{children}
		</FileTreeContext.Provider>
	);
};
