// Phase 9a: opening the same file twice in a row (the main.tex auto-open
// racing a restore/selection with a stale `tabs` closure) must leave one
// tab, not timestamped twins.
import { render, screen, act } from '@testing-library/react';
import React, { useContext, useEffect, useRef } from 'react';

import {
	EditorTabsContext,
	EditorTabsProvider,
} from '@/contexts/EditorTabsContext';

jest.mock('@/hooks/useProperties', () => ({
	useProperties: () => ({
		isReady: true,
		getProperty: () => undefined,
		setProperty: () => undefined,
		registerProperty: () => undefined,
	}),
}));

const MAIN_TEX = {
	title: 'main.tex',
	type: 'file' as const,
	fileId: 'file-main-tex',
	filePath: '/manuscript/main.tex',
};

function Probe() {
	const ctx = useContext(EditorTabsContext);
	// Capture the opener once and call it twice synchronously: with the old
	// timestamped ids the stale closure mints two tabs; the fix collapses
	// them in the state updater.
	const did = useRef(false);
	useEffect(() => {
		if (did.current || !ctx) return;
		did.current = true;
		const open = ctx.openTab;
		open({ ...MAIN_TEX });
		open({ ...MAIN_TEX });
	}, [ctx]);
	if (!ctx) return null;
	return <div data-testid="tab-count">{ctx.tabs.length}</div>;
}

test('two rapid opens of the same file leave a single tab', async () => {
	// Distinct timestamps per call: the real race spans an async gap, so the
	// two opens mint different ids under the old timestamped scheme.
	let now = 1000;
	const spy = jest.spyOn(Date, 'now').mockImplementation(() => (now += 17));
	try {
		await act(async () => {
			render(
				<EditorTabsProvider>
					<Probe />
				</EditorTabsProvider>,
			);
		});
		expect(screen.getByTestId('tab-count').textContent).toBe('1');
	} finally {
		spy.mockRestore();
	}
});
