// Phase 9a: the assistant view gets its own (wider) persisted sidebar width.
import { renderHook, act } from '@testing-library/react';

import {
	ASSISTANT_SIDEBAR_DEFAULT_WIDTH,
	useEditorLayout,
} from '@src/hooks/editor/useEditorLayout';

jest.mock('@src/hooks/useProperties', () => ({
	useProperties: () => ({
		isReady: true,
		getProperty: () => undefined,
		setProperty: jest.fn(),
		registerProperty: jest.fn(),
	}),
}));

jest.mock('@src/hooks/useTheme', () => ({
	useTheme: () => ({ currentLayout: undefined }),
}));

test('assistant sidebar defaults wider than the explorer and persists resizes', () => {
	const { result } = renderHook(() => useEditorLayout());
	expect(result.current.sidebarWidth).toBe(250);
	expect(result.current.assistantWidth).toBe(ASSISTANT_SIDEBAR_DEFAULT_WIDTH);
	expect(ASSISTANT_SIDEBAR_DEFAULT_WIDTH).toBeGreaterThan(250);

	act(() => {
		result.current.handleAssistantResize(420);
	});
	expect(result.current.assistantWidth).toBe(420);
	// The explorer width is untouched by an assistant resize.
	expect(result.current.sidebarWidth).toBe(250);

	act(() => {
		result.current.handleSidebarResize(300);
	});
	expect(result.current.sidebarWidth).toBe(300);
	expect(result.current.assistantWidth).toBe(420);
});
