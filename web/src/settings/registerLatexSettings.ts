// src/settings/registerLatexSettings.ts
import { useEffect, useRef } from 'react';

import { t } from '@/i18n';
import { useSettings } from '../hooks/useSettings';
import type { LaTeXOutputFormat, LaTeXEngine } from '../types/latex';

export function useRegisterLatexSettings() {
	const { registerSetting, getSetting } = useSettings();
	const settingsRegistered = useRef(false);

	useEffect(() => {
		if (settingsRegistered.current) return;
		settingsRegistered.current = true;

		const initialEngine =
			(getSetting('latex-engine')?.value as LaTeXEngine) ?? 'busytex-xetex';
		const initialStoreCache =
			(getSetting('latex-store-cache')?.value as boolean) ?? true;
		const initialStoreWorkingDirectory =
			(getSetting('latex-store-working-directory')?.value as boolean) ?? false;
		const initialSourceMap =
			(getSetting('latex-sourcemap-enable')?.value as boolean) ?? true;
		const initialAutoCompile =
			(getSetting('latex-auto-compile-on-open')?.value as boolean) ?? false;
		const initialDefaultFormat =
			(getSetting('latex-default-format')?.value as LaTeXOutputFormat) ?? 'pdf';
		const initialAutoNavigate =
			(getSetting('latex-auto-navigate-to-main')?.value as string) ??
			'conditional';

		registerSetting({
			id: 'latex-engine',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'select',
			label: t('{typesetter} Engine', { typesetter: t('LaTeX') }),
			description: t('Choose the {typesetter} engine for compilation', {
				typesetter: t('LaTeX'),
			}),
			defaultValue: initialEngine,
			options: [
				{
					label: t('pdfTeX (BusyTeX / TeX Live 2026)'),
					value: 'busytex-pdftex',
				},
				{ label: t('XeTeX (BusyTeX / TeX Live 2026)'), value: 'busytex-xetex' },
				{
					label: t('LuaTeX (BusyTeX / TeX Live 2026)'),
					value: 'busytex-luatex',
				},
			],
		});

		registerSetting({
			id: 'latex-sourcemap-enable',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'checkbox',
			label: t('Enable source map (SyncTeX)'),
			description: t(
				'Enable SyncTeX source mapping between editor and PDF output',
			),
			defaultValue: initialSourceMap,
		});

		registerSetting({
			id: 'latex-auto-compile-on-open',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'checkbox',
			label: t('Auto-compile on project open'),
			description: t(
				'Automatically compile {typesetter} when opening a project',
				{ typesetter: t('LaTeX') },
			),
			defaultValue: initialAutoCompile,
		});

		registerSetting({
			id: 'latex-auto-navigate-to-main',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'select',
			label: t('Auto-navigate to main file on compile'),
			description: t(
				'Control when to automatically navigate to the main {typesetter} file during compilation',
				{
					typesetter: t('LaTeX'),
				},
			),
			defaultValue: initialAutoNavigate,
			options: [
				{
					label: t('Only when no {typesetter} file is open', {
						typesetter: t('LaTeX'),
					}),
					value: 'conditional',
				},
				{ label: t('Always navigate to main file'), value: 'always' },
				{ label: t('Never navigate to main file'), value: 'never' },
			],
		});

		registerSetting({
			id: 'latex-default-format',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'select',
			label: t('Default output format'),
			description: t('Default format for {typesetter} compilation', {
				typesetter: t('LaTeX'),
			}),
			defaultValue: initialDefaultFormat,
			options: [
				{ label: t('PDF'), value: 'pdf' },
				{ label: t('Canvas (PDF)'), value: 'canvas-pdf' },
			],
		});

		registerSetting({
			id: 'latex-store-cache',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'checkbox',
			label: t('Store compilation cache'),
			description: t('Save TeX cache files for faster subsequent compilations'),
			defaultValue: initialStoreCache,
		});

		registerSetting({
			id: 'latex-store-working-directory',
			category: t('Compilation'),
			subcategory: t('LaTeX'),
			type: 'checkbox',
			label: t('Store working directory'),
			description: t('Save all working directory files after compilation'),
			defaultValue: initialStoreWorkingDirectory,
		});
	}, [registerSetting, getSetting]);
}
