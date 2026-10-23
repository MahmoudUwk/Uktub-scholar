// src/types/latex.ts
import type { CompileResult } from './compilation';
declare global {
	interface Window {
		PdfTeXEngine: any;
		XeTeXEngine: any;
		ENGINE_PATH?: string;
		onPdfTeXEngineReady?: () => void;
	}
}

export type LaTeXOutputFormat = 'pdf' | 'canvas-pdf';

export const LATEX_ENGINES = [
	'busytex-pdftex',
	'busytex-xetex',
	'busytex-luatex',
] as const;

export type LaTeXEngine = (typeof LATEX_ENGINES)[number];

declare global {
	interface DocumentEventMap {
		'trigger-compile-with-engine': CustomEvent<{ engine: LaTeXEngine }>;
	}
}

export interface LaTeXContextType {
	isCompiling: boolean;
	isInitializing: boolean;
	setIsInitializing: (value: boolean) => void;
	isExporting: boolean;
	setIsExporting: (value: boolean) => void;
	compileError: string | null;
	compiledPdf: Uint8Array | null;
	compiledCanvas: Uint8Array | null;
	clearCache: () => Promise<void>;
	compileWithClearCache: (mainFileName: string) => Promise<void>;
	compileLog: string;
	compileDocument: (
		mainFileName: string,
		format?: LaTeXOutputFormat,
	) => Promise<void>;
	/**
	 * Agent compile (Phase 7): the SAME engine run the Compile button runs
	 * (BusyTeX, default XeLaTeX) under the page-wide mutex, with the same
	 * viewer/log updates, but returning the result for the worker finish.
	 * Rejects on agent Stop (after stopping the engine) and throws
	 * EngineMissingError when BusyTeX cannot load.
	 */
	compileForAgent: (
		entryRel: string,
		signal?: AbortSignal,
	) => Promise<CompileResult>;
	stopCompilation: () => void;
	toggleOutputView: () => void;
	currentView: 'log' | 'output';
	currentFormat: LaTeXOutputFormat;
	logIndicator: 'idle' | 'warn' | 'error' | 'success';
	latexEngine: LaTeXEngine;
	activeCompiler: string | null;
	setLatexEngine: (engine: LaTeXEngine) => Promise<void>;
	triggerAutoCompile: () => void;
	exportDocument: (
		mainFileName: string,
		options?: {
			engine?: LaTeXEngine;
			format?: 'pdf' | 'dvi';
			includeLog?: boolean;
			includeDvi?: boolean;
			includeBbl?: boolean;
			includeWorkDir?: boolean;
		},
	) => Promise<void>;
}
