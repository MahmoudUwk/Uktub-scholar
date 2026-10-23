// src/services/LaTeXService.ts
import { nanoid } from 'nanoid';

import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import { uktubProjectService } from './UktubProjectService';
import { busyTexService } from '../extensions/texlyre-busytex/BusyTeXService';
import type { BusyTeXEngineType } from '../extensions/texlyre-busytex/BusyTeXEngine';
import type { CompileResult } from '../types/compilation';
import type { FileNode } from '../types/files';
import { downloadFiles } from '../utils/archiveUtils';
import { fileStoreService } from './FileStoreService';
import {
	notificationService,
	shouldShowNotification,
	type NotificationOptions,
} from './NotificationService';

const moduleLog = createNamedLogger('LaTeXService');

export type EngineType = BusyTeXEngineType;

type LaTeXNotificationOptions = NotificationOptions<string>;
type ExportFile = { content: Uint8Array; name: string; mimeType: string };

const SUPPORTED_ENGINES: EngineType[] = [
	'busytex-pdftex',
	'busytex-xetex',
	'busytex-luatex',
];

class LaTeXService {
	private currentEngineType: EngineType = 'busytex-xetex';
	private statusListeners: Set<() => void> = new Set();
	private currentOperationId: string | null = null;
	private compileGeneration = 0;

	setStoreCache(store: boolean): void {
		busyTexService.setStoreCache(store);
	}

	setStoreWorkingDirectory(store: boolean): void {
		busyTexService.setStoreWorkingDirectory(store);
	}

	setFlattenMainDirectory(flatten: boolean): void {
		busyTexService.setFlattenMainDirectory(flatten);
	}

	setBusyTeXBundles(bundles: string[]): void {
		busyTexService.setSelectedBundles(bundles);
	}

	getCurrentOperationId(): string | null {
		return this.currentOperationId;
	}

	async isBusyTeXBundleCached(bundleId: string): Promise<boolean> {
		return busyTexService.isBundleCached(bundleId);
	}

	async deleteBusyTeXBundle(bundleId: string): Promise<void> {
		await busyTexService.deleteBundle(bundleId);
	}

	async initialize(engineType: EngineType = 'busytex-xetex'): Promise<void> {
		this.currentEngineType = engineType;
		await busyTexService.initialize(engineType);
		this.notifyStatusChange();
	}

	async setEngine(engineType: EngineType): Promise<void> {
		if (this.currentEngineType === engineType) return;
		await this.initialize(engineType);
	}

	getCurrentEngineType(): EngineType {
		return this.currentEngineType;
	}
	getSupportedEngines(): EngineType[] {
		return SUPPORTED_ENGINES;
	}
	getStatus(): string {
		return this.activeEngine().getStatus();
	}
	isReady(): boolean {
		return this.activeEngine().isReady();
	}
	isCompiling(): boolean {
		return this.activeEngine().isCompiling();
	}

	addStatusListener(listener: () => void): () => void {
		this.statusListeners.add(listener);
		const busyUnsub = busyTexService.addStatusListener(() =>
			this.notifyStatusChange(),
		);
		return () => {
			this.statusListeners.delete(listener);
			busyUnsub();
		};
	}

	async compileLaTeX(
		mainFileName: string,
		fileTree: FileNode[],
		format: string = 'pdf',
	): Promise<CompileResult> {
		const generation = ++this.compileGeneration;
		const operationId = `latex-compile-${nanoid()}`;
		this.currentOperationId = operationId;

		await this.ensureEngineReady(this.currentEngineType, operationId, format);
		if (generation !== this.compileGeneration) {
			return this.stoppedCompileResult();
		}

		try {
			this.showLoadingNotification(
				t('Compiling {typesetter} to {format}...', {
					typesetter: t('LaTeX'),
					format: format.toUpperCase(),
				}),
				operationId,
				format,
			);
			const result = await this.runCompile(
				this.currentEngineType,
				mainFileName,
				fileTree,
			);

			if (generation !== this.compileGeneration) {
				return this.stoppedCompileResult();
			}

			this.reportCompileOutcome(result, operationId, format);
			return result;
		} catch (error) {
			if (generation !== this.compileGeneration) {
				return this.stoppedCompileResult();
			}

			return this.handleCompileError(
				error,
				this.activeEngine().getStatus(),
				operationId,
				format,
			);
		}
	}

	async clearCacheDirectories(): Promise<void> {
		const operationId = `latex-clear-cache-${nanoid()}`;
		try {
			this.showLoadingNotification(
				t('Clearing {typesetter} cache...', { typesetter: t('LaTeX') }),
				operationId,
			);
			await busyTexService.terminate();
			this.showSuccessNotification(
				t('{typesetter} cache cleared successfully', {
					typesetter: t('LaTeX'),
				}),
				{
					operationId,
					duration: 2000,
				},
			);
		} catch (error) {
			moduleLog.error('Error clearing cache directories:', error);
			this.showErrorNotification(
				t('Failed to clear {typesetter} cache', { typesetter: t('LaTeX') }),
				{
					operationId,
					duration: 3000,
				},
			);
			throw error;
		}
	}

	async clearCacheAndCompile(
		mainFileName: string,
		fileTree: FileNode[],
		format: string = 'pdf',
	): Promise<CompileResult> {
		await this.clearCacheDirectories();
		return this.compileLaTeX(mainFileName, fileTree, format);
	}

	stopCompilation(): void {
		this.compileGeneration += 1;
		this.activeEngine().stopCompilation();
	}

	async exportDocument(
		mainFileName: string,
		fileTree: FileNode[],
		options: {
			engine?: EngineType;
			format?: 'pdf' | 'dvi';
			includeLog?: boolean;
			includeDvi?: boolean;
			includeBbl?: boolean;
			includeWorkDir?: boolean;
		} = {},
	): Promise<void> {
		const targetEngine = options.engine ?? this.currentEngineType;
		const operationId = `latex-export-${nanoid()}`;

		try {
			this.showLoadingNotification(t('Compiling for export...'), operationId);

			await this.exportWithBusyTeX(
				targetEngine,
				mainFileName,
				fileTree,
				options,
				operationId,
			);
		} catch (error) {
			this.showErrorNotification(
				`Export error: ${error instanceof Error ? error.message : t('Unknown error')}`,
				{ operationId, duration: 5000 },
			);
			throw error;
		}
	}

	async reinitializeCurrentEngine(): Promise<void> {
		busyTexService.terminate();
		await busyTexService.initialize(this.currentEngineType);
	}

	dismissCurrentNotification(): void {
		if (this.currentOperationId)
			notificationService.dismiss(this.currentOperationId);
	}

	showLoadingNotification(
		message: string,
		operationId?: string,
		format?: string,
	): void {
		if (this.canNotify('loading', format))
			notificationService.showLoading(message, operationId);
	}

	showSuccessNotification(
		message: string,
		options: LaTeXNotificationOptions = {},
	): void {
		if (this.canNotify('success', options.format))
			notificationService.showSuccess(message, options);
	}

	showErrorNotification(
		message: string,
		options: LaTeXNotificationOptions = {},
	): void {
		if (this.canNotify('error', options.format))
			notificationService.showError(message, options);
	}

	showInfoNotification(
		message: string,
		options: LaTeXNotificationOptions = {},
	): void {
		if (this.canNotify('info', options.format))
			notificationService.showInfo(message, options);
	}

	private activeEngine() {
		return busyTexService;
	}

	private async ensureEngineReady(
		engine: EngineType,
		operationId: string,
		format: string,
	): Promise<void> {
		if (
			busyTexService.isReady() &&
			busyTexService.getCurrentEngineType() === engine
		)
			return;
		this.showLoadingNotification(
			t('Initializing BusyTeX engine...'),
			operationId,
			format,
		);
		await busyTexService.initialize(engine);
	}

	private async runCompile(
		engine: EngineType,
		mainFileName: string,
		fileTree: FileNode[],
	): Promise<CompileResult> {
		void engine;
		// Uktub `/proj` owns the files: push debounced editor saves before the
		// engine reads the tree, so compile always sees the latest content.
		await uktubProjectService.flush();
		const nodesWithContent = await this.loadFileContents(
			this.collectAllFiles(fileTree),
		);
		return busyTexService.compile(mainFileName, nodesWithContent);
	}

	private async exportWithBusyTeX(
		engine: BusyTeXEngineType,
		mainFileName: string,
		fileTree: FileNode[],
		options: {
			includeLog?: boolean;
			includeBbl?: boolean;
			includeWorkDir?: boolean;
		},
		operationId: string,
	): Promise<void> {
		if (
			!busyTexService.isReady() ||
			busyTexService.getCurrentEngineType() !== engine
		) {
			await busyTexService.initialize(engine);
		}

		const needsWorkDir = !!(options.includeBbl || options.includeWorkDir);
		const originalStoreWorking = busyTexService.getStoreWorkingDirectory();
		if (needsWorkDir) busyTexService.setStoreWorkingDirectory(true);

		try {
			const nodesWithContent = await this.loadFileContents(
				this.collectAllFiles(fileTree),
			);
			const result = await busyTexService.compile(
				mainFileName,
				nodesWithContent,
			);

			if (result.status !== 0 || !result.pdf) {
				this.showErrorNotification(t('Export failed'), {
					operationId,
					duration: 3000,
				});
				return;
			}

			const baseName = this.getBaseName(mainFileName);
			const files: ExportFile[] = [
				{
					content: result.pdf,
					name: `${baseName}.pdf`,
					mimeType: 'application/pdf',
				},
			];

			if (options.includeLog) {
				files.push({
					content: new TextEncoder().encode(result.log),
					name: `${baseName}.log`,
					mimeType: 'text/plain',
				});
			}
			if (options.includeBbl) {
				const bbl = await busyTexService.extractBblFile(mainFileName);
				if (bbl) files.push(bbl);
			}
			if (options.includeWorkDir) {
				files.push(...(await busyTexService.collectStoredWorkFiles()));
			}

			await downloadFiles(files, baseName);
			this.showSuccessNotification(t('Export completed successfully'), {
				operationId,
				duration: 2000,
			});
		} finally {
			if (needsWorkDir) {
				busyTexService.setStoreWorkingDirectory(originalStoreWorking);
				if (!originalStoreWorking)
					await busyTexService.cleanupStoredWorkDirectory();
			}
		}
	}

	private notifyStatusChange(): void {
		this.statusListeners.forEach((l) => {
			l();
		});
	}

	private reportCompileOutcome(
		result: CompileResult,
		operationId: string,
		format: string,
	): void {
		const succeeded =
			result.status === 0 && result.pdf && result.pdf.length > 0;
		if (succeeded) {
			this.showSuccessNotification(
				t('{typesetter} {format} compilation completed', {
					typesetter: t('LaTeX'),
					format: format.toUpperCase(),
				}),
				{ operationId, duration: 3000, format },
			);
		} else {
			this.showErrorNotification(
				t('{typesetter} compilation failed', {
					typesetter: t('LaTeX'),
				}),
				{
					operationId,
					duration: 5000,
					format,
				},
			);
		}
	}

	private handleCompileError(
		error: unknown,
		engineStatus: string,
		operationId: string,
		format: string,
	): CompileResult {
		if (engineStatus === 'error' || engineStatus === 'unloaded') {
			this.showInfoNotification(t('Compilation stopped by user'), {
				operationId,
				duration: 2000,
				format,
			});
			return {
				pdf: undefined,
				status: -1,
				log: 'Compilation failed or was stopped by user.',
			};
		}
		this.showErrorNotification(
			`Compilation error: ${error instanceof Error ? error.message : t('Unknown error')}`,
			{ operationId, duration: 5000, format },
		);
		throw error;
	}

	private stoppedCompileResult(): CompileResult {
		return {
			pdf: undefined,
			status: -1,
			log: 'Compilation stopped by user.',
		};
	}

	private collectAllFiles(nodes: FileNode[]): FileNode[] {
		const result: FileNode[] = [];
		for (const n of nodes) {
			if (n.type === 'file') result.push(n);
			if (n.children?.length) result.push(...this.collectAllFiles(n.children));
		}
		return result;
	}

	private async loadFileContents(nodes: FileNode[]): Promise<FileNode[]> {
		const result: FileNode[] = [];
		for (const node of nodes) {
			if (node.content !== undefined) {
				result.push(node);
				continue;
			}
			try {
				const raw = await fileStoreService.getFile(node.id);
				if (raw?.content) result.push({ ...node, content: raw.content });
			} catch {}
		}
		return result;
	}

	private getBaseName(filePath: string): string {
		const name = filePath.split('/').pop() || filePath;
		return name.includes('.') ? name.split('.').slice(0, -1).join('.') : name;
	}

	private canNotify(
		type: 'loading' | 'success' | 'error' | 'info',
		format?: string,
	): boolean {
		const canvas = format?.toLowerCase().includes('canvas') ?? false;
		return shouldShowNotification(
			canvas ? 'canvas-renderer-notifications' : 'pdf-renderer-notifications',
			type,
			canvas ? 'off' : 'all',
		);
	}
}

export const latexService = new LaTeXService();
