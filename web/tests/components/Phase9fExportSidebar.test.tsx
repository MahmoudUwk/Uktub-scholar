// Phase 9f requirement: legacy TeXlyre UI leftovers are gone. The export
// modal is one plain action (Uktub copy, no TeXlyre text, no include
// toggles) that always exports the full round-trip payload; the editor
// sidebar has no Collab tab and no documents view (FileExplorer covers
// the sidebar; document/file sync machinery is untouched).
// RED before the 9f removal, green after.
import fs from 'node:fs';
import path from 'node:path';

import { fireEvent, render, screen } from '@testing-library/react';
import type React from 'react';

jest.mock('@src/services/AccountExportService', () => ({
    accountExportService: {
        exportProjects: jest.fn(),
    },
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ProjectExportModal: React.ComponentType<{
    isOpen: boolean;
    onClose: () => void;
    selectedProjects: Array<{ id: string; name: string; updatedAt: number }>;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
}> = require('@src/components/project/ProjectExportModal').default;

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { accountExportService } = require('@src/services/AccountExportService');

jest.mock('@src/components/editor/DocumentExplorer', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    default: () => require('react').createElement('div', { 'data-testid': 'document-explorer' }),
}));

jest.mock('@src/components/editor/FileExplorer', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    default: () => require('react').createElement('div', { 'data-testid': 'file-explorer' }),
}));

jest.mock('@src/components/editor/SearchPanel', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    default: () => require('react').createElement('div', { 'data-testid': 'search-panel' }),
}));

jest.mock('@src/components/history/GitHistoryPanel', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    default: () => require('react').createElement('div', { 'data-testid': 'history-panel' }),
}));

jest.mock('@src/components/common/ResizablePanel', () => ({
    __esModule: true,
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    default: ({ children }: { children?: React.ReactNode }) =>
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('react').createElement('div', null, children),
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const EditorSidebar: React.ComponentType<Record<string, unknown>> =
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('@src/components/editor/EditorSidebar').default;

const SIDEBAR_SOURCE = path.join(
    __dirname,
    '..',
    '..',
    'src',
    'components',
    'editor',
    'EditorSidebar.tsx',
);

function renderSidebar(activeView: string) {
    return render(
        <EditorSidebar
            activeView={activeView}
            sidebarWidth={280}
            minSidebarWidth={200}
            maxSidebarWidth={500}
            sidebarCollapsed={false}
            explorerHeight={300}
            onSidebarResize={jest.fn()}
            onSidebarCollapse={jest.fn()}
            onExplorerResize={jest.fn()}
            onViewChange={jest.fn()}
            onHistorySelect={jest.fn()}
            onOpenDiff={jest.fn()}
            onClearDiff={jest.fn()}
            onNavigateToSearchResult={jest.fn()}
            collabProjectId={undefined}
            docsWithPeers={new Set<string>()}
            onFileSelect={jest.fn()}
            initialSelectedFile={undefined}
            initialExpandedPaths={undefined}
            currentProjectId='p1'
            onExportCurrentProject={jest.fn()}
            projectType='latex'
            assistantPanel={null}
        />,
    );
}

describe('Phase 9f export modal requirements', () => {
    it('has no TeXlyre copy and no include toggles', () => {
        render(
            <ProjectExportModal
                isOpen={true}
                onClose={jest.fn()}
                selectedProjects={[{ id: 'p1', name: 'P1', updatedAt: Date.now() }]}
            />,
        );
        expect(screen.queryByText(/TeXlyre/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/collaboration data/i)).not.toBeInTheDocument();
        expect(screen.queryByText(/cache and temporary files/i)).not.toBeInTheDocument();
        expect(document.querySelectorAll('input[type="checkbox"]').length).toBe(0);
    });

    it('says it exports the registry for re-import into this app', () => {
        render(
            <ProjectExportModal
                isOpen={true}
                onClose={jest.fn()}
                selectedProjects={[{ id: 'p1', name: 'P1', updatedAt: Date.now() }]}
            />,
        );
        expect(screen.queryByText(/Uktub registry/i)).toBeInTheDocument();
        expect(screen.queryByText(/re-import into this app/i)).toBeInTheDocument();
    });

    it('exports the full round-trip payload with one click (no toggles to enable)', () => {
        render(
            <ProjectExportModal
                isOpen={true}
                onClose={jest.fn()}
                selectedProjects={[{ id: 'p1', name: 'P1', updatedAt: Date.now() }]}
            />,
        );
        const button = screen.getByRole('button', { name: /Export 1 Project/ });
        expect(button).not.toBeDisabled();
        fireEvent.click(button);
        expect(accountExportService.exportProjects).toHaveBeenCalledWith(
            ['p1'],
            expect.objectContaining({
                includeDocuments: true,
                includeFiles: true,
                includeTemporaryFiles: false,
            }),
        );
    });
});

describe('Phase 9f editor sidebar requirements', () => {
    it('source has no Collab tab or documents view', () => {
        const source = fs.readFileSync(SIDEBAR_SOURCE, 'utf8');
        expect(source).not.toContain('Collab');
        expect(source).not.toContain('UsersIcon');
        expect(source).not.toContain('DocumentExplorer');
        expect(source).not.toMatch(/activeView === 'documents'/);
    });

    it('renders no Collab tab; the documents view falls back to files', () => {
        const { unmount } = renderSidebar('files');
        expect(screen.queryByTitle('Collab')).not.toBeInTheDocument();
        expect(screen.queryByLabelText('Collab')).not.toBeInTheDocument();
        expect(screen.queryByTestId('document-explorer')).not.toBeInTheDocument();
        unmount();
        renderSidebar('documents');
        expect(screen.queryByTestId('document-explorer')).not.toBeInTheDocument();
        expect(screen.queryByTestId('file-explorer')).toBeInTheDocument();
    });
});
