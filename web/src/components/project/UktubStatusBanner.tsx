// Banner surfacing the Uktub `/proj` bridge state: a second-tab lock
// refusal or a missing/broken worker shows here instead of corrupting files.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
import type React from 'react';

import { t } from '@/i18n';
import { useFileTree } from '../../hooks/useFileTree';

const UktubStatusBanner: React.FC = () => {
	const { uktubStatus } = useFileTree();

	if (
		uktubStatus.kind === 'idle' ||
		uktubStatus.kind === 'opening' ||
		uktubStatus.kind === 'ready'
	) {
		return null;
	}

	return (
		<div
			className='ui-message'
			data-role='uktub-status-banner'
			data-tone='warning'
		>
			<div className='ui-stack' data-gap='xs'>
				<strong>
					{uktubStatus.kind === 'locked'
						? t('Project open in another tab')
						: t('Project files unavailable')}
				</strong>
				{uktubStatus.message && (
					<div className='ui-note'>{uktubStatus.message}</div>
				)}
			</div>
		</div>
	);
};

export default UktubStatusBanner;
