/**
 * ngrok.hooks.tsx -- Renderer-process hook registrations for the ngrok feature.
 */

import * as LocalRenderer from '@getflywheel/local/renderer';
import { createNgrokRow } from './NgrokRow';

export function registerNgrokHooks(
	React: typeof import('react'),
	hooks: typeof LocalRenderer.HooksRenderer,
): void {
	const NgrokRow = createNgrokRow(React);

	hooks.addContent('SiteInfoOverview_TableList', (site) => (
		<NgrokRow key="wordpress-supercharged-ngrok" site={site} />
	));
}
