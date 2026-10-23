// src/services/AccountExportService.ts
import { saveAs } from 'file-saver';

import { t } from '@/i18n';
import { createNamedLogger } from '@/logging';
import { authService } from './AuthService';
import {
	type BackupLayoutService,
	type SerializedProjectDocuments,
	type SerializedProjectFiles,
	UnifiedDataStructureService,
} from './BackupLayoutService';
import { ProjectDataService } from './ProjectDataService';
import { uktubProjectService } from './UktubProjectService';
import { WriteTargetService, ZipTarget } from './WriteTargetService';

const moduleLog = createNamedLogger('AccountExportService');

export interface ExportOptions {
	includeDocuments?: boolean;
	includeFiles?: boolean;
	includeTemporaryFiles?: boolean;
	projectIds?: string[];
	format?: 'texlyre';
	isSingleProjectExport?: boolean;
}

class AccountExportService {
	private dataSerializer = new ProjectDataService();
	private fileSystemManager = new WriteTargetService();
	private unifiedService = new UnifiedDataStructureService();


	async exportProjects(
		projectIds: string[],
		options: ExportOptions = {},
	): Promise<void> {
		const user = authService.getCurrentUser();
		if (!user) {
			throw new Error(t('User not authenticated'));
		}

		const exportOptions: ExportOptions = {
			includeDocuments: true,
			includeFiles: true,
			includeTemporaryFiles: false,
			...options,
			projectIds,
			isSingleProjectExport: projectIds.length === 1,
		};

		await this.exportWithOptions(user.id, exportOptions);
	}

	private async exportWithOptions(
		userId: string,
		options: ExportOptions,
	): Promise<void> {
		try {
			const user = authService.getCurrentUser();
			if (!user || user.id !== userId) {
				throw new Error(t('User not authenticated'));
			}

			const account = null;

			const projects = await this.dataSerializer.serializeProjects(
				userId,
				'export',
				options.projectIds,
			);

			const manifest = this.unifiedService.createManifest('export');
			const projectData: BackupLayoutService['projectData'] = new Map();

			for (const project of projects) {
				if (options.projectIds && !options.projectIds.includes(project.id)) {
					continue;
				}

				let documents: SerializedProjectDocuments = {
					documents: [],
					documentContents: new Map(),
				};
				let files: SerializedProjectFiles = {
					files: [],
					fileContents: new Map(),
					deletedFiles: [],
				};

				if (options.includeDocuments) {
					documents = await this.dataSerializer.serializeProjectDocuments({
						id: project.id,
						name: project.name,
						description: project.description,
						type: project.type || 'latex',
						group: project.group,
						docUrl: project.docUrl,
						createdAt: project.createdAt,
						updatedAt: project.updatedAt,
						ownerId: project.ownerId,
						tags: project.tags,
						isFavorite: project.isFavorite,
					});
				}

				if (options.includeFiles) {
					files = await this.dataSerializer.serializeProjectFiles(
						{
							id: project.id,
							name: project.name,
							description: project.description,
							type: project.type || 'latex',
							group: project.group,
							docUrl: project.docUrl,
							createdAt: project.createdAt,
							updatedAt: project.updatedAt,
							ownerId: project.ownerId,
							tags: project.tags,
							isFavorite: project.isFavorite,
						},
						false,
						options.includeTemporaryFiles,
					);
				}

				projectData.set(project.id, {
					metadata: project,
					documents: documents.documents,
					documentContents: documents.documentContents,
					files: files.files,
					fileContents: files.fileContents,
				});
			}

			// The export also carries each exported project's Uktub worker
			// state (`/proj` files zip + registry DB) under
			// `projects/<id>/uktub/`. A failed worker export fails the whole
			// export naming the project — never a silent registry-less
			// archive.
			const uktubPayloads = new Map<
				string,
				{ zip: Uint8Array; registry: Uint8Array | null }
			>();
			for (const project of projects) {
				if (options.projectIds && !options.projectIds.includes(project.id)) {
					continue;
				}
				try {
					uktubPayloads.set(
						project.id,
						await uktubProjectService.exportUktubPayload(project.id),
					);
				} catch (error) {
					const reason =
						error instanceof Error ? error.message : String(error);
					throw new Error(
						`Uktub export failed for project "${project.name}": ${reason}`,
					);
				}
				if (uktubPayloads.get(project.id)?.registry === null) {
					throw new Error(
						`Uktub export failed for project "${project.name}": worker returned no registry`,
					);
				}
			}

			const unifiedData = {
				manifest,
				account,
				projects,
				projectData,
			};

			const zipAdapter = new ZipTarget();

			await this.fileSystemManager.writeUnifiedStructure(
				zipAdapter,
				unifiedData,
			);
			for (const [projectId, payload] of uktubPayloads) {
				await zipAdapter.writeFile(
					this.unifiedService.getUktubFilesZipPath(projectId),
					payload.zip,
				);
				if (payload.registry) {
					await zipAdapter.writeFile(
						this.unifiedService.getUktubRegistryPath(projectId),
						payload.registry,
					);
				}
			}

			const zipBlob = await zipAdapter.generateZip();
			const timestamp = new Date()
				.toISOString()
				.replace(/:/g, '-')
				.substring(0, 19);

			const fileName = `texlyre-projects-${timestamp}.zip`;

			saveAs(zipBlob, fileName);
		} catch (error) {
			moduleLog.error('Error exporting:', error);
			if (error instanceof Error && error.message.startsWith('Uktub export failed')) {
				throw error;
			}
			const detail = error instanceof Error ? `: ${error.message}` : '';
			throw new Error(`${t('Failed to export data')}${detail}`);
		}
	}

}

export const accountExportService = new AccountExportService();
