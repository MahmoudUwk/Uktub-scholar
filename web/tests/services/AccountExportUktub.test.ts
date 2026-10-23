import { File as NodeFile } from 'node:buffer';

jest.mock('@/i18n', () => ({
	t: (message: string) => message,
}));

jest.mock('file-saver', () => ({
	saveAs: jest.fn(),
}));

jest.mock('@src/services/AuthService', () => ({
	authService: {
		getCurrentUser: jest.fn(),
	},
}));

jest.mock('@src/services/ProjectDataService', () => ({
	ProjectDataService: jest.fn().mockImplementation(() => ({
		serializeProjects: jest.fn(async () => [
			{
				id: 'p1',
				name: 'P One',
				description: '',
				type: 'latex',
				docUrl: 'yjs:p1',
				createdAt: 1,
				updatedAt: 2,
				ownerId: 'u1',
				tags: [],
				isFavorite: false,
			},
		]),
		serializeProjectDocuments: jest.fn(async () => ({
			documents: [],
			documentContents: new Map(),
		})),
		serializeProjectFiles: jest.fn(async () => ({
			files: [],
			fileContents: new Map(),
			deletedFiles: [],
		})),
	})),
}));

jest.mock('@src/services/UktubProjectService', () => ({
	uktubProjectService: {
		exportUktubPayload: jest.fn(),
	},
}));

import { saveAs } from 'file-saver';

import { accountExportService } from '@src/services/AccountExportService';
import { authService } from '@src/services/AuthService';
import { uktubProjectService } from '@src/services/UktubProjectService';
import { ZipTarget } from '@src/services/WriteTargetService';

const USER = { id: 'u1', username: 'u1' };

async function exportedZip(): Promise<ZipTarget> {
	const mockSaveAs = saveAs as unknown as jest.Mock;
	expect(mockSaveAs).toHaveBeenCalledTimes(1);
	const blob = mockSaveAs.mock.calls[0][0] as Blob;
	// This jsdom Blob has no arrayBuffer(); FileReader reads it fine.
	const buffer = await new Promise<ArrayBuffer>((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => resolve(reader.result as ArrayBuffer);
		reader.onerror = () => reject(reader.error);
		reader.readAsArrayBuffer(blob);
	});
	const zip = new ZipTarget();
	await zip.loadFromBlob(
		new NodeFile([buffer], 'export.zip', { type: 'application/zip' }) as unknown as File,
	);
	return zip;
}

describe('AccountExportService TeXlyre export carries the Uktub payload', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(authService.getCurrentUser as jest.Mock).mockReturnValue(USER);
	});

	it('stores the worker export bytes under projects/<id>/uktub/', async () => {
		const zipBytes = new Uint8Array([80, 75, 3, 4, 9, 9, 9]);
		const regBytes = new Uint8Array([83, 81, 76, 105, 116, 101, 7, 7, 7]);
		(uktubProjectService.exportUktubPayload as jest.Mock).mockResolvedValue({
			zip: zipBytes,
			registry: regBytes,
		});

		await accountExportService.exportProjects(['p1'], { format: 'texlyre' });

		expect(uktubProjectService.exportUktubPayload).toHaveBeenCalledWith('p1');
		const zip = await exportedZip();
		expect(await zip.exists('projects/p1/uktub/proj.zip')).toBe(true);
		expect(await zip.exists('projects/p1/uktub/registry.db')).toBe(true);
		expect(new Uint8Array((await zip.readFile('projects/p1/uktub/proj.zip')) as ArrayBuffer)).toEqual(zipBytes);
		expect(new Uint8Array((await zip.readFile('projects/p1/uktub/registry.db')) as ArrayBuffer)).toEqual(regBytes);
	});

	it('a refused Uktub export fails naming the project and writes no archive', async () => {
		(uktubProjectService.exportUktubPayload as jest.Mock).mockRejectedValue(
			new Error('open-in-another-tab'),
		);

		await expect(
			accountExportService.exportProjects(['p1'], { format: 'texlyre' }),
		).rejects.toThrow(/P One/);
		expect(saveAs).not.toHaveBeenCalled();
	});
});
