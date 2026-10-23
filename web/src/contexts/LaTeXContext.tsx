// src/contexts/LaTeXContext.tsx
import type React from 'react';
import {
	type ReactNode,
	createContext,
	useEffect,
	useCallback,
	useRef,
	useState,
} from 'react';

import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import { useFileTree } from '../hooks/useFileTree';
import { useSettings } from '../hooks/useSettings';
import { latexService } from '../services/LaTeXService';
import { fileStoreService } from '../services/FileStoreService';
import type {
	LaTeXContextType,
	LaTeXOutputFormat,
	LaTeXEngine,
} from '../types/latex';
import type { CompileResult } from '../types/compilation';
import { compileMutex } from '../services/compileMutex';
import {
	EngineMissingError,
	engineMissingMessage,
	ENGINE_MISSING_NEXT,
} from '../services/compileEngineError';
import { LATEX_ENGINES } from '../types/latex';
import {
	parseUrlFragments,
	replaceHash,
	getProjectName,
} from '../utils/urlUtils';
import { popoutViewerService } from '../services/PopoutViewerService';

/**
 * Thrown inside the page-wide compile turn when an outside Stop (the Compile
 * button's stop, or the agent timeout path) kills the in-flight engine run.
 * The BusyTeX worker promise never settles after `terminate()` (its only
 * fallback is the runner's own 180s timeout), so the turn races the engine
 * against this rejection instead of awaiting it past the stop.
 */
class EngineStoppedError extends Error {
	constructor() {
		super('Compilation stopped');
		this.name = 'EngineStoppedError';
	}
}

const moduleLog = createNamedLogger('LaTeXContext');

export const LaTeXContext = createContext<LaTeXContextType | null>(null);

interface LaTeXProviderProps {
	children: ReactNode;
}

export const LaTeXProvider: React.FC<LaTeXProviderProps> = ({ children }) => {
	const { fileTree } = useFileTree();
	const { getSetting } = useSettings();

	const [isCompiling, setIsCompiling] = useState<boolean>(false);
	const [isInitializing, setIsInitializing] = useState(false);
	const [isExporting, setIsExporting] = useState(false);
	const [hasAutoCompiled, setHasAutoCompiled] = useState(false);
	const [compileError, setCompileError] = useState<string | null>(null);
	const [compiledPdf, setCompiledPdf] = useState<Uint8Array | null>(null);
	const [compiledCanvas, setCompiledCanvas] = useState<Uint8Array | null>(null);
	const [compileLog, setCompileLog] = useState<string>('');
	const [currentView, setCurrentView] = useState<'log' | 'output'>('log');
	const [logIndicator, setLogIndicator] = useState<
		'idle' | 'success' | 'error'
	>('idle');
	const [activeCompiler, setActiveCompiler] = useState<string | null>(null);
	const compileInProgressRef = useRef(false);
	const requestRef = useRef(0);
	/** Settles the in-flight engine await the moment an outside Stop lands. */
	const stopRejectRef = useRef<(() => void) | null>(null);

	const latexEngine =
		(getSetting('latex-engine')?.value as LaTeXEngine) ?? 'busytex-xetex';
	const currentFormat =
		(getSetting('latex-default-format')?.value as LaTeXOutputFormat) ?? 'pdf';
	const storeCache =
		(getSetting('latex-store-cache')?.value as boolean) ?? true;
	const storeWorkingDirectory =
		(getSetting('latex-store-working-directory')?.value as boolean) ?? false;

	useEffect(() => {
		const handleCompilerActive = (event: CustomEvent) => {
			setActiveCompiler(event.detail.type);
		};
		document.addEventListener(
			'compiler-active',
			handleCompilerActive as EventListener,
		);
		return () => {
			document.removeEventListener(
				'compiler-active',
				handleCompilerActive as EventListener,
			);
		};
	}, []);

	useEffect(() => {
		latexService.setStoreCache(storeCache);
		latexService.setStoreWorkingDirectory(storeWorkingDirectory);
		latexService.setBusyTeXBundles(['recommended']);
	}, [storeCache, storeWorkingDirectory]);

	/**
	 * Apply one engine result to the viewer/log panels. Shared by the Compile
	 * button, clear-cache compile and the agent compile (Phase 7) so the
	 * agent's result shows exactly like a button run.
	 */
	const applyCompileResult = (
		mainFileName: string,
		result: CompileResult,
		format: LaTeXOutputFormat,
	): void => {
		setCompileLog(result.log);
		if (result.status === 0 && result.pdf) {
			switch (format) {
				case 'pdf': {
					setCompiledPdf(result.pdf);
					setCurrentView('output');
					setLogIndicator('success');
					const fileName =
						mainFileName
							.split('/')
							.pop()
							?.replace(/\.(tex|ltx|latex)$/i, '.pdf') || 'output.pdf';
					popoutViewerService.sendContent({
						kind: 'pdf',
						content: result.pdf,
						mimeType: 'application/pdf',
						fileName,
						projectName: getProjectName(t('LaTeX Project')),
					});
					break;
				}
				case 'canvas-pdf': {
					setCompiledCanvas(result.pdf);
					setCurrentView('output');
					setLogIndicator('success');
					const canvasFileName =
						mainFileName
							.split('/')
							.pop()
							?.replace(/\.(tex|ltx|latex)$/i, '.pdf') || 'output.pdf';
					popoutViewerService.sendContent({
						kind: 'canvas-pdf',
						content: result.pdf,
						mimeType: 'application/pdf',
						fileName: canvasFileName,
						projectName: getProjectName(t('LaTeX Project')),
					});
					break;
				}
			}
		} else {
			setCompileError(
				t('Compilation failed. Check the log in the main window.'),
			);
			if (format === 'pdf') setCurrentView('log');
			setLogIndicator('error');
			popoutViewerService.sendCompileResult(result.status, result.log);
		}
	};

	/**
	 * Race one engine run against the outside-Stop rejection (see
	 * `EngineStoppedError`). Arms `stopRejectRef` for the turn; the caller
	 * clears it once the race settles.
	 */
	const raceEngineStop = <T,>(run: Promise<T>): Promise<T> => {
		const stop = new Promise<never>((_, reject) => {
			stopRejectRef.current = () => reject(new EngineStoppedError());
		});
		return Promise.race([run, stop]);
	};

	const compileDocument = async (
		mainFileName: string,
		format: LaTeXOutputFormat = currentFormat,
	): Promise<void> => {
		const requestId = ++requestRef.current;

		// Busy immediately, even while queued behind another compile: a
		// second request waits on the page-wide mutex instead of dropping.
		setIsCompiling(true);
		setCompileError(null);
		setActiveCompiler('latex');

		// setCompiledPdf(null);
		setCompiledCanvas(null);

		try {
			await compileMutex.run(async () => {
				compileInProgressRef.current = true;
				try {
					const engineToUse = latexService.getCurrentEngineType();
					if (!latexService.isReady()) {
						await latexService.initialize(engineToUse);
					}

					if (requestId !== requestRef.current) return;
				} catch (error) {
					if (requestId !== requestRef.current) return;
					throw error;
				} finally {
					if (requestId === requestRef.current) {
						setIsInitializing(false);
					}
				}

				if (requestId !== requestRef.current) return;

				try {
					let result: CompileResult;
					try {
						result = await raceEngineStop(
							latexService.compileLaTeX(mainFileName, fileTree, format),
						);
					} finally {
						stopRejectRef.current = null;
					}

					if (requestId !== requestRef.current) return;

					applyCompileResult(mainFileName, result, format);
				} catch (error) {
					if (requestId !== requestRef.current) return;

					setCompileError(
						error instanceof Error ? error.message : t('Unknown error'),
					);
					setCurrentView('log');
					setLogIndicator('error');

					popoutViewerService.sendCompileResult(
						-1,
						error instanceof Error ? error.message : t('Unknown error'),
					);
				} finally {
					compileInProgressRef.current = false;
				}
			});
		} finally {
			if (requestId === requestRef.current) {
				setIsCompiling(false);
			}
		}
	};

	/**
	 * Agent compile (Phase 7): the SAME engine run the Compile button runs
	 * (BusyTeX, default XeLaTeX) under the page-wide mutex, with the same
	 * viewer/log updates, but returning the result for the worker finish.
	 * Rejects on agent Stop (after stopping the engine) and throws
	 * EngineMissingError when BusyTeX cannot load.
	 */
	const compileForAgent = async (
		entryRel: string,
		signal?: AbortSignal,
	): Promise<CompileResult> => {
		setIsCompiling(true);
		setCompileError(null);
		setActiveCompiler('latex');
		setCompiledCanvas(null);

		try {
			return await compileMutex.run(async () => {
				if (signal?.aborted) {
					throw (
						signal.reason ??
						new DOMException('The operation was aborted', 'AbortError')
					);
				}
				const engineToUse = latexService.getCurrentEngineType();
				if (!latexService.isReady()) {
					try {
						await latexService.initialize(engineToUse);
					} catch (error) {
						throw new EngineMissingError(
							engineMissingMessage(
								error instanceof Error ? error.message : String(error),
							),
							ENGINE_MISSING_NEXT,
						);
					}
				}
				const abortStop = (): void => {
					latexService.stopCompilation();
				};
				signal?.addEventListener('abort', abortStop, { once: true });
				try {
					// Stopping the engine orphans the in-flight worker promise (it
					// never settles after terminate()), so race it: the agent abort
					// rejects at once, an outside Stop returns the stopped result
					// without touching the viewer (it already shows the stop), and
					// the turn always releases.
					const stop = new Promise<never>((_, reject) => {
						stopRejectRef.current = () => reject(new EngineStoppedError());
					});
					const aborted = new Promise<never>((_, reject) => {
						if (signal === undefined) return;
						if (signal.aborted) {
							reject(
								signal.reason ??
									new DOMException('The operation was aborted', 'AbortError'),
							);
						} else {
							signal.addEventListener(
								'abort',
								() =>
									reject(
										signal.reason ??
											new DOMException(
												'The operation was aborted',
												'AbortError',
											),
									),
								{ once: true },
							);
						}
					});
					let result: CompileResult;
					try {
						// Phase 9d D1: stage the project as it is when the compile
						// runs. The agent is built once (cached in the panel), so
						// the render's `fileTree` predates every file the agent
						// created since; building the tree here, after the flush,
						// stages those files too.
						const freshTree = await fileStoreService.buildFileTree();
						result = await Promise.race([
							latexService.compileLaTeX(entryRel, freshTree, 'pdf'),
							stop,
							aborted,
						]);
					} finally {
						stopRejectRef.current = null;
					}
					if (signal?.aborted) {
						throw (
							signal.reason ??
							new DOMException('The operation was aborted', 'AbortError')
						);
					}
					applyCompileResult(entryRel, result, 'pdf');
					return result;
				} catch (error) {
					if (error instanceof EngineStoppedError && !signal?.aborted) {
						return { status: -1, log: 'Compilation stopped by user.' };
					}
					throw error;
				} finally {
					stopRejectRef.current = null;
					signal?.removeEventListener('abort', abortStop);
				}
			}, signal);
		} finally {
			setIsCompiling(false);
		}
	};

	const handleSetLatexEngine = useCallback(
		async (_engine: LaTeXEngine): Promise<void> => {
			// NOTE (fabawi): no-op since engine is now driven by project properties with global setting fallback.
		},
		[],
	);

	const triggerAutoCompile = useCallback(() => {
		const hashUrl = window.location.hash.substring(1);
		const fragments = parseUrlFragments(hashUrl);
		const engine = fragments.compile as LaTeXEngine;
		const isLatexEngine = LATEX_ENGINES.includes(engine);

		if (isLatexEngine) {
			const cleanUrl = hashUrl.replace(/&compile:[^&]*/, '');
			replaceHash(cleanUrl);
			document.dispatchEvent(
				new CustomEvent('trigger-compile-with-engine', { detail: { engine } }),
			);
			setHasAutoCompiled(true);
			return;
		}

		const autoCompileEnabled =
			(getSetting('latex-auto-compile-on-open')?.value as boolean) ?? false;
		if (autoCompileEnabled && !hasAutoCompiled) {
			document.dispatchEvent(new CustomEvent('trigger-compile'));
			setHasAutoCompiled(true);
		}
	}, [getSetting, hasAutoCompiled]);

	const stopCompilation = () => {
		if (!isCompiling && !compileInProgressRef.current) return;

		requestRef.current += 1;
		compileInProgressRef.current = false;
		// Settle the in-flight engine await at once: the terminated worker
		// promise never settles on its own (only its own 180s timeout would).
		stopRejectRef.current?.();
		stopRejectRef.current = null;

		latexService.stopCompilation();
		latexService.dismissCurrentNotification();

		setIsCompiling(false);
		setIsInitializing(false);
		setCompileError(t('Compilation stopped by user'));
	};

	const exportDocument = async (
		mainFileName: string,
		options: {
			engine?: LaTeXEngine;
			format?: 'pdf' | 'dvi';
			includeLog?: boolean;
			includeDvi?: boolean;
			includeBbl?: boolean;
			includeWorkDir?: boolean;
		} = {},
	): Promise<void> => {
		setIsExporting(true);
		try {
			// Export shares the engine: wait behind an in-flight compile.
			await compileMutex.run(async () => {
				await latexService.exportDocument(mainFileName, fileTree, options);
			});
		} finally {
			setIsExporting(false);
		}
	};

	const toggleOutputView = () => {
		setCurrentView(currentView === 'log' ? 'output' : 'log');
	};

	const clearCache = async (): Promise<void> => {
		try {
			await latexService.clearCacheDirectories();
		} catch (error) {
			moduleLog.error('Failed to clear cache:', error);
			setCompileError('Failed to clear cache');
		}
	};

	const compileWithClearCache = async (
		mainFileName: string,
		format: LaTeXOutputFormat = currentFormat,
	): Promise<void> => {
		const requestId = ++requestRef.current;

		setIsCompiling(true);
		setCompileError(null);
		setActiveCompiler('latex');

		setCompiledPdf(null);
		setCompiledCanvas(null);

		try {
			await compileMutex.run(async () => {
				compileInProgressRef.current = true;
				try {
					const engineToUse = latexService.getCurrentEngineType();
					if (!latexService.isReady()) {
						await latexService.initialize(engineToUse);
					}

					if (requestId !== requestRef.current) return;
				} catch (error) {
					if (requestId !== requestRef.current) return;
					throw error;
				} finally {
					if (requestId === requestRef.current) {
						setIsInitializing(false);
					}
				}

				if (requestId !== requestRef.current) return;

				try {
					await latexService.clearCacheDirectories();
					if (requestId !== requestRef.current) return;

					let result: CompileResult;
					try {
						result = await raceEngineStop(
							latexService.compileLaTeX(mainFileName, fileTree, format),
						);
					} finally {
						stopRejectRef.current = null;
					}

					if (requestId !== requestRef.current) return;

					applyCompileResult(mainFileName, result, format);
				} catch (error) {
					if (requestId !== requestRef.current) return;

					setCompileError(
						error instanceof Error ? error.message : t('Unknown error'),
					);
					setCurrentView('log');
					setLogIndicator('error');

					popoutViewerService.sendCompileResult(
						-1,
						error instanceof Error ? error.message : t('Unknown error'),
					);
				} finally {
					compileInProgressRef.current = false;
				}
			});
		} finally {
			if (requestId === requestRef.current) {
				setIsCompiling(false);
			}
		}
	};

	return (
		<LaTeXContext.Provider
			value={{
				isCompiling,
				isInitializing,
				setIsInitializing,
				isExporting,
				setIsExporting,
				compileError,
				compiledPdf,
				compiledCanvas,
				compileLog,
				currentFormat,
				compileDocument,
				compileForAgent,
				stopCompilation,
				toggleOutputView,
				currentView,
				logIndicator,
				latexEngine,
				setLatexEngine: handleSetLatexEngine,
				clearCache,
				compileWithClearCache,
				triggerAutoCompile,
				activeCompiler,
				exportDocument,
			}}
		>
			{children}
		</LaTeXContext.Provider>
	);
};
