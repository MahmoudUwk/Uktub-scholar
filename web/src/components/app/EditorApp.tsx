// src/components/app/EditorApp.tsx
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import { CollabProvider } from '../../contexts/CollabContext';
import { FileTreeProvider } from '../../contexts/FileTreeContext';
import { LaTeXProvider } from '../../contexts/LaTeXContext';
import { TypstProvider } from '../../contexts/TypstContext';
import { ExternalTypesetterProvider } from '../../contexts/ExternalTypesetterContext';
import { SourceMapProvider } from '../../contexts/SourceMapContext';
import { ContentFormatterProvider } from '../../contexts/ContentFormatterContext';
import { useAuth } from '../../hooks/useAuth';
import { useWheelScroll } from '../../hooks/useWheelScroll';
import { useLaTeX } from '../../hooks/useLaTeX';
import { useCollab } from '../../hooks/useCollab';
import { useGlobalKeyboard } from '../../hooks/useGlobalKeyboard';
import { useOffline } from '../../hooks/useOffline';
import { useSettings } from '../../hooks/useSettings';
import { fileStoreService } from '../../services/FileStoreService';
import { typesetterRegistryService } from '../../services/TypesetterRegistryService';
import { popoutViewerService } from '../../services/PopoutViewerService';
import type { DocumentList } from '../../types/documents';
import type { YjsDocUrl } from '../../types/yjs';
import type { LaTeXEngine } from '../../types/latex';
import type { ProjectType, ProjectGroup } from '../../types/projects';
import { EditIcon, ProjectsIcon } from '../common/Icons';
import Modal from '../common/Modal';
import OfflineBanner from '../common/OfflineBanner';
import ToastContainer from '../common/ToastContainer';
import TypesetterInfo from '../common/TypesetterInfo';
import FileDocumentController from '../editor/FileDocumentController';
import LaTeXCompileButton from '../output/LaTeXCompileButton';
import LaTeXExportButton from '../output/LaTeXExportButton';
import ExternalCompileButton from '../output/ExternalCompileButton';
import ExternalExportButton from '../output/ExternalExportButton';
import ProjectForm from '../project/ProjectForm';
import SettingsButton from '../settings/SettingsButton';
import KeyboardShortcutsModal from '../common/KeyboardShortcutsModal';
import PrivacyModal from '../common/PrivacyModal';
import { isValidYjsUrl, pushHash } from '../../utils/urlUtils';
import { clickWhenReady } from '../../utils/editorNavigator';
import FooterLinks from '../common/FooterLinks';
import QuotaBanner from '../common/QuotaBanner';

const moduleLog = createNamedLogger('EditorApp');

interface EditorAppProps {
	docUrl: YjsDocUrl;
	onBackToProjects: () => void;
	onLogout: () => void;
	targetDocId?: string | null;
	targetFilePath?: string | null;
}

const EditorAppView: React.FC<EditorAppProps> = ({
	docUrl,
	onBackToProjects,
	targetDocId,
	targetFilePath,
}) => {
	const {
		data: doc,
		changeData: changeDoc,
		isConnected,
	} = useCollab<DocumentList>();
	const hasDoc = !!doc;

	const { user, updateProject, getProjectById } = useAuth();
	const headerRightRef = useWheelScroll<HTMLDivElement>();
	const [isEditingMetadata, setIsEditingMetadata] = useState(false);
	const [isSubmitting, setIsSubmitting] = useState(false);
	const [localDocId, setLocalDocId] = useState<string>('');
	const externalAutoCompiledRef = useRef<string | null>(null);
	const [linkedFileInfo, setLinkedFileInfo] = useState<{
		fileName?: string;
		filePath?: string;
		fileId?: string;
	} | null>(null);
	const lastSyncedMetadata = useRef({
		name: '',
		description: '',
		type: 'latex' as ProjectType,
		group: undefined as ProjectGroup | undefined,
		compilerId: undefined as string | undefined,
		mainFile: undefined as string | undefined,
		latexEngine: undefined as LaTeXEngine | undefined,
	});
	const { isCompiling, triggerAutoCompile } = useLaTeX();
	const { isOfflineMode, hideOfflineBanner } = useOffline();
	const { getSetting } = useSettings();

	const [showKeyboardShortcuts, setShowKeyboardShortcuts] = useState(false);
	const [showPrivacy, setShowPrivacy] = useState(false);

	const selectedDocument = doc?.documents?.find((d) => d.id === localDocId);
	const projectName = doc?.projectMetadata?.name || 'Untitled Project';
	const projectDescription = doc?.projectMetadata?.description || '';

	const projectType = doc?.projectMetadata?.type || 'latex';
	// Only latex projects can be created now; when the Yjs metadata cache is
	// empty (e.g. after the view is rebuilt from `/proj`), fall back to the
	// latex default instead of hiding the compile buttons.
	const projectTypeKnown =
		doc?.projectMetadata?.type !== undefined || projectType === 'latex';
	const projectCompilerId = doc?.projectMetadata?.compilerId;
	const activeTypesetterProvider = typesetterRegistryService.resolve(
		projectType,
		projectCompilerId,
	);
	const externalAutoCompileOnOpen =
		(getSetting('external-typesetter-auto-compile-on-open')
			?.value as boolean) ?? false;

	useGlobalKeyboard();

	const updateContent = (docId: string, content: string) => {
		changeDoc((d) => {
			if (d.documents) {
				const docIndex = d.documents.findIndex((doc) => doc.id === docId);
				if (docIndex !== -1) {
					d.documents[docIndex].content = content;
				}
			}
		});
	};
	const handleCreateDocument = () => {
		changeDoc((d) => {
			if (!d.documents) {
				d.documents = [];
			}
			const newDocId = Math.random().toString(36).substring(2, 15);
			const newDocName = `Document ${d.documents.length + 1}`;
			d.documents.push({
				id: newDocId,
				name: newDocName,
				content: '',
				createdAt: Date.now(),
			});
			d.currentDocId = newDocId;
		});
		if (doc?.documents) {
			setLocalDocId(doc.documents[doc.documents.length - 1].id);
		}
	};

	const handleSelectDocument = useCallback((docId: string) => {
		setLocalDocId(docId);
	}, []);

	const handleUpdateContent = (content: string) => {
		updateContent(localDocId, content);
	};

	const handleRenameDocument = (docId: string, newName: string) => {
		changeDoc((d) => {
			if (d.documents) {
				const docIndex = d.documents.findIndex((doc) => doc.id === docId);
				if (docIndex !== -1) {
					d.documents[docIndex].name = newName;
				}
			}
		});
	};

	const persistProjectMetadata = useCallback(
		async (metadata: {
			name?: string;
			description?: string;
			type?: ProjectType;
			group?: ProjectGroup;
			compilerId?: string;
			mainFile?: string;
			latexEngine?: LaTeXEngine;
		}) => {
			const projectId = sessionStorage.getItem('currentProjectId');
			const name = metadata.name;

			if (
				!name ||
				name === 'Untitled Project' ||
				name === 'Shared Project' ||
				!projectId
			) {
				return;
			}

			const next = {
				name,
				description: metadata.description || '',
				type: metadata.type || ('latex' as ProjectType),
				group: metadata.group,
				compilerId: metadata.compilerId,
				mainFile: metadata.mainFile,
				latexEngine: metadata.latexEngine,
			};
			const previous = lastSyncedMetadata.current;

			if (
				previous.name === next.name &&
				previous.description === next.description &&
				previous.type === next.type &&
				previous.group === next.group &&
				previous.compilerId === next.compilerId &&
				previous.mainFile === next.mainFile &&
				previous.latexEngine === next.latexEngine
			) {
				return;
			}

			lastSyncedMetadata.current = next;

			try {
				const project = await getProjectById(projectId);
				if (project) {
					await updateProject({
						...project,
						name: next.name,
						description: next.description,
						type: next.type,
						group: next.group ?? project.group,
						compilerId: next.compilerId,
					});
					document.dispatchEvent(new CustomEvent('project-metadata-updated'));
				}
			} catch (error) {
				moduleLog.error('Failed to sync project metadata:', error);
			}
		},
		[getProjectById, updateProject],
	);

	const handleUpdateProjectMetadata = async (projectData: {
		name: string;
		description: string;
		type?: ProjectType;
		group?: ProjectGroup;
		compilerId?: string;
	}) => {
		setIsSubmitting(true);
		changeDoc((d) => {
			if (!d.projectMetadata) {
				d.projectMetadata = {
					name: projectData.name,
					description: projectData.description,
					type: projectData.type || 'latex',
					group: projectData.group,
					compilerId: projectData.compilerId,
				};
			} else {
				d.projectMetadata.name = projectData.name;
				d.projectMetadata.description = projectData.description;
				d.projectMetadata.type = projectData.type || 'latex';
				d.projectMetadata.group = projectData.group;
				d.projectMetadata.compilerId = projectData.compilerId;
			}
		});
		await persistProjectMetadata({
			...doc?.projectMetadata,
			...projectData,
		});
		setIsSubmitting(false);
		setIsEditingMetadata(false);
	};

	const handleNavigateToLinkedFile = () => {
		if (linkedFileInfo?.filePath) {
			document.dispatchEvent(
				new CustomEvent('navigate-to-linked-file', {
					detail: {
						filePath: linkedFileInfo.filePath,
						fileId: linkedFileInfo.fileId,
					},
				}),
			);
		}
	};

	const handleExpandLatexOutput = () => {
		if (!popoutViewerService.isWindowOpen()) {
			document.dispatchEvent(new CustomEvent('expand-latex-output'));
		}
	};

	const handleExpandExternalOutput = () => {
		if (!popoutViewerService.isWindowOpen()) {
			document.dispatchEvent(new CustomEvent('expand-external-output'));
		}
	};

	useEffect(() => {
		const handleCompile = () => {
			if (isCompiling) return;

			const buttonSelectors = ['.header-compile-button .compile-button'];

			clickWhenReady(buttonSelectors);
		};

		const handleCompileClean = () => {
			if (isCompiling) return;

			const containerSelectors = ['.header-compile-button'];

			for (const selector of containerSelectors) {
				const container = document.querySelector(selector) as any;
				if (container && container.clearAndCompile) {
					container.clearAndCompile();
					return;
				}
			}
		};

		const handleStopCompilation = () => {
			if (isCompiling) {
				const latexCompileButton = document.querySelector(
					'.header-compile-button .compile-button',
				) as HTMLButtonElement;
				if (latexCompileButton) {
					latexCompileButton.click();
				}
			}
		};

		document.addEventListener('trigger-compile', handleCompile);
		document.addEventListener('trigger-compile-clean', handleCompileClean);
		document.addEventListener(
			'trigger-stop-compilation',
			handleStopCompilation,
		);

		return () => {
			document.removeEventListener('trigger-compile', handleCompile);
			document.removeEventListener('trigger-compile-clean', handleCompileClean);
			document.removeEventListener(
				'trigger-stop-compilation',
				handleStopCompilation,
			);
		};
	}, [isCompiling]);

	useEffect(() => {
		if (!hasDoc || !activeTypesetterProvider) return;

		const timer = setTimeout(() => {
			if (activeTypesetterProvider.id === 'internal:latex') {
				triggerAutoCompile();
				return;
			}

			if (
				activeTypesetterProvider.source === 'chelys' &&
				externalAutoCompileOnOpen
			) {
				const key = `${fileStoreService.getCurrentProjectId() ?? ''}:${activeTypesetterProvider.id}`;
				if (externalAutoCompiledRef.current === key) return;
				externalAutoCompiledRef.current = key;
				document.dispatchEvent(new CustomEvent('trigger-compile'));
			}
		}, 1000);

		return () => clearTimeout(timer);
	}, [
		hasDoc,
		activeTypesetterProvider,
		externalAutoCompileOnOpen,
		triggerAutoCompile,
	]);

	useEffect(() => {
		if (doc) {
			const projectMetadata = sessionStorage.getItem('projectMetadata');
			if (projectMetadata) {
				const parsedMetadata = JSON.parse(projectMetadata);
				changeDoc((d) => {
					d.projectMetadata = {
						name: parsedMetadata.name || 'Untitled Project',
						description: parsedMetadata.description || '',
						type: parsedMetadata.type || 'latex',
						compilerId: parsedMetadata.compilerId,
						mainFile: parsedMetadata.mainFile,
						latexEngine: parsedMetadata.latexEngine,
					};
					sessionStorage.removeItem('projectMetadata');
				});
			}
		}
	}, [doc, changeDoc]);

	// Rebuild wiped Yjs metadata (a cache) from the durable project record so
	// a reload after an IndexedDB wipe still shows the project.
	useEffect(() => {
		if (!doc || doc.projectMetadata) return;
		const pid = sessionStorage.getItem('currentProjectId');
		if (!pid) return;
		void getProjectById(pid).then((p) => {
			if (!p) return;
			changeDoc((d) => {
				d.projectMetadata = {
					name: p.name || 'Untitled Project',
					description: p.description || '',
					type: p.type || 'latex',
					group: p.group,
					compilerId: p.compilerId,
				};
			});
		});
	}, [doc, changeDoc, getProjectById]);

	useEffect(() => {
		if (doc?.projectMetadata) {
			persistProjectMetadata(doc.projectMetadata);
		}
	}, [doc?.projectMetadata, persistProjectMetadata]);

	useEffect(() => {
		if (targetDocId) return;
		if (targetFilePath) return;
		if (doc?.currentDocId === undefined) return;

		setLocalDocId(doc.currentDocId);
	}, [doc?.currentDocId, targetDocId, targetFilePath]);

	useEffect(() => {
		if (!doc?.documents) return;
		if (!targetDocId) return;

		const targetDoc = doc.documents.find((d) => d.id === targetDocId);
		if (targetDoc) {
			handleSelectDocument(targetDocId);
		}
	}, [doc, targetDocId, handleSelectDocument]);

	useEffect(() => {
		const checkLinkedFile = async () => {
			if (localDocId && doc?.documents) {
				try {
					const allFiles = await fileStoreService.getAllFiles(
						false,
						false,
						false,
					);
					const linkedFile = allFiles.find(
						(file) => file.documentId === localDocId,
					);

					if (linkedFile) {
						setLinkedFileInfo({
							fileName: linkedFile.name,
							filePath: linkedFile.path,
							fileId: linkedFile.id,
						});
					} else {
						setLinkedFileInfo(null);
					}
				} catch (error) {
					moduleLog.error('Error checking for linked file:', error);
					setLinkedFileInfo(null);
				}
			} else {
				setLinkedFileInfo(null);
			}
		};

		checkLinkedFile();
	}, [localDocId, doc?.documents]);

	const CompileButtons = () => {
		if (!projectTypeKnown) return null;

		const latexButtons = [
			<LaTeXCompileButton
				key='latex'
				dropdownKey={'latex-header-dropdown'}
				className='header-compile-button'
				selectedDocId={localDocId}
				documents={doc?.documents}
				onNavigateToLinkedFile={handleNavigateToLinkedFile}
				onExpandLatexOutput={handleExpandLatexOutput}
				linkedFileInfo={linkedFileInfo}
				shouldNavigateOnCompile={true}
				useSharedSettings={true}
			/>,

			<LaTeXExportButton
				key='latex-export'
				className='output-export-button'
				selectedDocId={localDocId}
				documents={doc?.documents}
				linkedFileInfo={linkedFileInfo}
				useSharedSettings={true}
			/>,
		];

		if (activeTypesetterProvider?.source === 'chelys') {
			return (
				<>
					<ExternalCompileButton
						provider={activeTypesetterProvider}
						className='header-compile-button'
						selectedDocId={localDocId}
						onNavigateToLinkedFile={handleNavigateToLinkedFile}
						onExpandExternalOutput={handleExpandExternalOutput}
						linkedFileInfo={linkedFileInfo}
						shouldNavigateOnCompile={true}
						useSharedSettings={true}
					/>
					<ExternalExportButton
						provider={activeTypesetterProvider}
						className='output-export-button'
						linkedFileInfo={linkedFileInfo}
					/>
				</>
			);
		}

		if (projectType === 'latex') {
			return (
				<>
					{latexButtons[0]}
					{latexButtons[1]}
				</>
			);
		}

		return null;
	};

	if (!isConnected && !doc) {
		return (
			<div className='app-container'>
				<div className='ui-loading-state' data-fill='true'>
					<div className='loading-spinner' />
					<p>{t('Connecting to project...')}</p>
				</div>
			</div>
		);
	}

	return (
		<div className='app-container'>
			{isOfflineMode && !hideOfflineBanner && <OfflineBanner />}
			<QuotaBanner />
			<header data-role='editor'>
				<div className='header-left ui-actions'>
					<button type='button' className='button' onClick={onBackToProjects}>
						<ProjectsIcon />
						{t('Projects')}
					</button>
				</div>
				<div className='header-center'>
					<div
						className='project-title-container'
						onClick={() => setIsEditingMetadata(true)}
					>
						<div className='project-title-header'>
							<h3 className='project-title'>{projectName}</h3>
							<button
								type='button'
								className='ui-icon-button'
								data-variant='subtle'
								data-size='sm'
								title={t('Edit Project Details')}
								onClick={(e) => {
									e.stopPropagation();
									setIsEditingMetadata(true);
								}}
							>
								<EditIcon />
							</button>
						</div>
					</div>
					{projectDescription && (
						<div className='project-description'>
							<p>{projectDescription}</p>
						</div>
					)}
				</div>
				<div className='header-right scroll-x ui-actions' ref={headerRightRef}>
					<CompileButtons />

					<SettingsButton className='header-settings-button' />
				</div>
			</header>

			{/* Always mounted: the file tree is a view over FileStoreService
				(which the Uktub bridge rebuilds from `/proj`), not over the
				Yjs documents array (empty until an editor opens a document). */}
			<FileDocumentController
					documents={doc?.documents || []}
					selectedDocId={localDocId}
					onSelectDocument={handleSelectDocument}
					onCreateDocument={handleCreateDocument}
					onRenameDocument={handleRenameDocument}
					onUpdateContent={handleUpdateContent}
					content={selectedDocument?.content || ''}
					docUrl={docUrl}
					targetDocId={targetDocId}
					targetFilePath={targetFilePath}
				/>

			<footer>
				<div className='footer-status ui-actions'>
					<div className='project-type-badge ui-badge' data-variant='label'>
						{t('Typesetter: ')}{' '}
						<TypesetterInfo
							type={projectType}
							provider={activeTypesetterProvider}
						/>
					</div>
				</div>

				<FooterLinks
					onShowPrivacy={() => {
						pushHash('privacy-policy');
						setShowPrivacy(true);
					}}
					onShowShortcuts={() => setShowKeyboardShortcuts(true)}
				/>
			</footer>

			<KeyboardShortcutsModal
				isOpen={showKeyboardShortcuts}
				onClose={() => setShowKeyboardShortcuts(false)}
			/>

			<PrivacyModal
				isOpen={showPrivacy}
				onClose={() => {
					setShowPrivacy(false);
					if (window.location.hash === '#privacy-policy') {
						history.back();
					}
				}}
			/>

			<Modal
				isOpen={isEditingMetadata}
				onClose={() => setIsEditingMetadata(false)}
				title={t('Edit Project Details')}
			>
				<ProjectForm
					project={{
						id: docUrl,
						name: projectName,
						description: projectDescription,
						type: projectType || 'latex',
						compilerId: projectCompilerId,
						docUrl: docUrl,
						createdAt: 0,
						updatedAt: 0,
						ownerId: user?.id || '',
						tags: [],
						isFavorite: false,
					}}
					onSubmit={handleUpdateProjectMetadata}
					onCancel={() => setIsEditingMetadata(false)}
					isSubmitting={isSubmitting}
					simpleMode={true}
				/>
			</Modal>

			<ToastContainer />
		</div>
	);
};

const EditorApp: React.FC<EditorAppProps> = (props) => {
	if (!isValidYjsUrl(props.docUrl)) {
		return (
			<div className='app-container'>
				<div className='ui-message' data-tone='error'>
					<p>{t('Invalid project URL.')}</p>
					<button
						type='button'
						className='button primary'
						onClick={props.onBackToProjects}
					>
						{t('Back to Projects')}
					</button>
				</div>
			</div>
		);
	}
	return (
		<CollabProvider docUrl={props.docUrl} collectionName='yjs_metadata'>
			<FileTreeProvider docUrl={props.docUrl}>
				<LaTeXProvider>
						<TypstProvider>
							<ExternalTypesetterProvider>
								<SourceMapProvider>
									<ContentFormatterProvider>
										<EditorAppView {...props} />
									</ContentFormatterProvider>
								</SourceMapProvider>
							</ExternalTypesetterProvider>
						</TypstProvider>
					</LaTeXProvider>
			</FileTreeProvider>
		</CollabProvider>
	);
};

export default EditorApp;
