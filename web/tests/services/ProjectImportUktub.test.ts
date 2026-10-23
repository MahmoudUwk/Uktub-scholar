import { File as NodeFile } from 'node:buffer';

jest.mock('@/i18n', () => ({
	t: (message: string) => message,
}));

jest.mock('@src/services/AuthService', () => ({
	authService: {
		getCurrentUser: jest.fn(),
		getProjectsByUser: jest.fn(),
		deleteProject: jest.fn(),
		db: Promise.resolve({ put: jest.fn() }),
	},
}));

jest.mock('@src/services/ProjectDataService', () => ({
	ProjectDataService: jest.fn().mockImplementation(() => ({
		deserializeToIndexedDB: jest.fn(async () => {}),
	})),
}));

jest.mock('@src/services/UktubProjectService', () => ({
	uktubProjectService: {
		importUktubPayload: jest.fn(),
	},
}));

import JSZip from 'jszip';

import { authService } from '@src/services/AuthService';
import { projectImportService } from '@src/services/ProjectImportService';
import { uktubProjectService } from '@src/services/UktubProjectService';

const USER = { id: 'u1', username: 'u1' };

const META = {
	id: 'src1',
	name: 'Source Project',
	description: '',
	type: 'latex',
	docUrl: 'yjs:src1',
	createdAt: 1,
	updatedAt: 2,
	ownerId: 'u1',
	tags: [],
	isFavorite: false,
};

// Built with raw JSZip (the archive code under test reads it back): strings
// for the JSON layout files, exact bytes for the Uktub payload.
async function buildArchive(withPayload: boolean): Promise<File> {
	const zip = new JSZip();
	zip.file('manifest.json', JSON.stringify({ version: '1.0.0', lastSync: 1, mode: 'export' }));
	zip.file('projects.json', JSON.stringify([META]));
	zip.file('projects/src1/metadata.json', JSON.stringify(META));
	if (withPayload) {
		zip.file('projects/src1/uktub/proj.zip', new Uint8Array([80, 75, 3, 4, 1, 2, 3]));
		zip.file('projects/src1/uktub/registry.db', new Uint8Array([83, 81, 76, 105, 116, 101, 4, 5, 6]));
	}
	const data = await zip.generateAsync({ type: 'uint8array' });
	return new NodeFile([data], 'backup.zip', { type: 'application/zip' }) as unknown as File;
}

describe('ProjectImportService restores the Uktub payload', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		(authService.getCurrentUser as jest.Mock).mockReturnValue(USER);
		(authService.getProjectsByUser as jest.Mock).mockResolvedValue([]);
	});

	it('imports the payload into the NEW project id with exactly those bytes', async () => {
		(uktubProjectService.importUktubPayload as jest.Mock).mockResolvedValue({
			filesImported: 3,
			registryImported: true,
		});

		const result = await projectImportService.importFromZip(await buildArchive(true), ['src1'], {});

		expect(result.errors).toEqual([]);
		expect(result.imported).toEqual(['src1']);
		expect(uktubProjectService.importUktubPayload).toHaveBeenCalledTimes(1);
		const [targetId, payload] = (uktubProjectService.importUktubPayload as jest.Mock).mock.calls[0];
		expect(targetId).toBe('src1');
		expect(payload.zip).toEqual(new Uint8Array([80, 75, 3, 4, 1, 2, 3]));
		expect(payload.registry).toEqual(new Uint8Array([83, 81, 76, 105, 116, 101, 4, 5, 6]));
	});

	it('an archive without the payload imports exactly as before', async () => {
		const result = await projectImportService.importFromZip(await buildArchive(false), ['src1'], {});

		expect(result.errors).toEqual([]);
		expect(result.imported).toEqual(['src1']);
		expect(uktubProjectService.importUktubPayload).not.toHaveBeenCalled();
	});

	it('a failed Uktub import surfaces as a failed project import with no project left listed', async () => {
		(uktubProjectService.importUktubPayload as jest.Mock).mockRejectedValue(
			new Error('open-in-another-tab'),
		);

		const result = await projectImportService.importFromZip(await buildArchive(true), ['src1'], {});

		expect(result.imported).toEqual([]);
		expect(result.errors).toHaveLength(1);
		expect(result.errors[0].projectId).toBe('src1');
		expect(authService.deleteProject).toHaveBeenCalledWith('src1');
	});
});
