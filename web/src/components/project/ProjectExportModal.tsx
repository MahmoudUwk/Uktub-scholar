// src/components/project/ProjectExportModal.tsx
import type React from 'react';
import { useState } from 'react';

import { t } from '@/i18n';
import {
	type ExportOptions,
	accountExportService,
} from '../../services/AccountExportService';
import type { Project } from '../../types/projects';
import { formatDate } from '../../utils/dateUtils';
import {
	ExportIcon,
	FileTextIcon,
	ZipFileIcon,
} from '../common/Icons';
import Modal from '../common/Modal';

interface ProjectExportModalProps {
	isOpen: boolean;
	onClose: () => void;
	selectedProjects: Project[];
}

const ProjectExportModal: React.FC<ProjectExportModalProps> = ({
	isOpen,
	onClose,
	selectedProjects,
}) => {
	const [exportFormat] = useState<'texlyre'>('texlyre');
	const [isExporting, setIsExporting] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const handleExport = async () => {
		if (selectedProjects.length === 0) return;

		setIsExporting(true);
		setError(null);

		try {
			// Phase 9f: one plain action — the Uktub payload always carries
			// the whole project (no include toggles; the round trip needs
			// documents, files and the registry every time).
			const options: ExportOptions = {
				includeDocuments: true,
				includeFiles: true,
				includeTemporaryFiles: false,
				format: exportFormat,
				projectIds: selectedProjects.map((p) => p.id),
			};

			await accountExportService.exportProjects(
				selectedProjects.map((p) => p.id),
				options,
			);

			onClose();
		} catch (error) {
			setError(error instanceof Error ? error.message : t('Export failed'));
		} finally {
			setIsExporting(false);
		}
	};

	const handleClose = () => {
		setError(null);
		setIsExporting(false);
		onClose();
	};

	return (
		<Modal
			isOpen={isOpen}
			onClose={handleClose}
			title={t('Export Projects')}
			icon={ZipFileIcon}
			size='medium'
		>
			<div className='ui-stack' data-gap='md'>
				{error && (
					<div className='ui-message' data-tone='error'>
						{error}
					</div>
				)}

				<div className='ui-message' data-tone='info'>
					<p>
						{t('Export {count} project in your preferred format.', {
							count: selectedProjects.length,
						})}
					</p>
				</div>

				<div className='ui-list' data-scroll='short'>
					{selectedProjects.map((project) => (
						<div
							key={project.id}
							className='ui-list-item'
							data-appearance='flat'
							data-padding='sm'
						>
							<strong>{project.name}</strong>
							<div className='ui-note'>
								{project.description || t('No description')}
							</div>
							<div className='ui-meta'>
								{t('Last Modified: {lastModified}', {
									lastModified: formatDate(project.updatedAt),
								})}
							</div>
						</div>
					))}
				</div>

				<section className='ui-stack' data-gap='sm'>
					<h3 className='ui-section-title'>{t('Export Format')}</h3>

					<div className='ui-stack' data-gap='sm'>
						<label
							className='ui-choice-card'
							data-direction='row'
							data-selected='true'
						>
							<input
								type='radio'
								name='exportFormat'
								value='texlyre'
								checked={exportFormat === 'texlyre'}
								onChange={() => {}}
							/>
							<FileTextIcon />
							<div className='ui-stack' data-gap='xs'>
								<strong>{t('Uktub Format')}</strong>
								<p className='ui-note'>
									{t(
										'Exports the project with its Uktub registry (papers registry, bibliography, sections, results) for re-import into this app.',
									)}
								</p>
							</div>
						</label>
					</div>
				</section>
			</div>

			<div
				className='ui-actions'
				data-variant='modal'
				data-align='end'
				data-cross='stretch'
			>
				<button
					type='button'
					className='button secondary'
					onClick={handleClose}
					disabled={isExporting}
				>
					{t('Cancel')}
				</button>
				<button
					type='button'
					className='button primary'
					onClick={handleExport}
					disabled={isExporting}
				>
					{isExporting ? (
						t('Exporting...')
					) : (
						<>
							<ExportIcon />
							{t('Export {count} Project', { count: selectedProjects.length })}
						</>
					)}
				</button>
			</div>
		</Modal>
	);
};

export default ProjectExportModal;
