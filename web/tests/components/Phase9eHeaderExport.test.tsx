// Phase 9e requirement: no user/account menu in the header, and the
// Projects-list export modal offers exactly one format (the TeXlyre-format
// archive carrying the Uktub registry). RED before the 9e removal, green after.
import fs from 'node:fs';
import path from 'node:path';

import { render, screen } from '@testing-library/react';
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

const PROFILE_DIR = path.join(__dirname, '..', '..', 'src', 'components', 'profile');

describe('Phase 9e header/export requirements', () => {
    it('has no user/account menu components', () => {
        for (const file of [
            'UserDropdown.tsx',
            'ProfileSettingsModal.tsx',
            'ExportAccountModal.tsx',
            'DeleteAccountModal.tsx',
            'ProfileAccountIdentitySection.tsx',
            'ProfileBrowserStorageSection.tsx',
            'ProfileLocalStorageDataSection.tsx',
            'ProfileChelysConnectionSection.tsx',
        ]) {
            expect(`${file} removed`).toBe(
                `${file} ${fs.existsSync(path.join(PROFILE_DIR, file)) ? 'still present' : 'removed'}`,
            );
        }
    });

    it('export modal renders a single format (no files-only choice)', () => {
        render(
            <ProjectExportModal
                isOpen={true}
                onClose={jest.fn()}
                selectedProjects={[{ id: 'p1', name: 'P1', updatedAt: Date.now() }]}
            />,
        );
        const radios = document.querySelectorAll('input[name="exportFormat"]');
        expect(radios.length).toBe(1);
        expect(screen.queryByText(/Files Only/i)).not.toBeInTheDocument();
    });
});
