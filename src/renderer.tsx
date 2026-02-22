import * as LocalRenderer from '@getflywheel/local/renderer';
import { ipcRenderer } from 'electron';
import { TableListRow } from '@getflywheel/local-components';
import { Switch } from '@getflywheel/local-components';

interface DebugSwitchesProps {
	site: { id: string };
}

const DEBUG_CONSTANTS = ['WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY'] as const;

type DebugState = Record<typeof DEBUG_CONSTANTS[number], boolean>;

const DEFAULT_STATE: DebugState = {
	WP_DEBUG: false,
	WP_DEBUG_LOG: false,
	WP_DEBUG_DISPLAY: false,
};

export default function (context: LocalRenderer.AddonRendererContext): void {
	const { React, hooks } = context;
	const { useState, useEffect, useCallback } = React;

	const DebugSwitches: React.FC<DebugSwitchesProps> = ({ site }) => {
		const [constants, setConstants] = useState<DebugState>(DEFAULT_STATE);
		const [loading, setLoading] = useState(true);
		const [updating, setUpdating] = useState<Record<string, boolean>>({});

		useEffect(() => {
			LocalRenderer.ipcAsync('supercharged:get-debug-constants', site.id)
				.then((result: DebugState) => setConstants(result))
				.catch(() => setConstants(DEFAULT_STATE))
				.finally(() => setLoading(false));

			LocalRenderer.ipcAsync('supercharged:watch-site', site.id);

			const handleExternalChange = (_event: any, siteId: string, updated: DebugState) => {
				if (siteId === site.id) {
					setConstants(updated);
				}
			};

			ipcRenderer.on('supercharged:debug-constants-changed', handleExternalChange);

			return () => {
				ipcRenderer.removeListener('supercharged:debug-constants-changed', handleExternalChange);
				LocalRenderer.ipcAsync('supercharged:unwatch-site', site.id);
			};
		}, [site.id]);

		const handleToggle = useCallback(
			async (name: string, value: boolean) => {
				const previous = constants[name as keyof DebugState];
				setConstants((prev) => ({ ...prev, [name]: value }));
				setUpdating((prev) => ({ ...prev, [name]: true }));

				try {
					await LocalRenderer.ipcAsync('supercharged:set-debug-constant', site.id, name, value);
				} catch (e) {
					setConstants((prev) => ({ ...prev, [name]: previous }));
				} finally {
					setUpdating((prev) => ({ ...prev, [name]: false }));
				}
			},
			[site.id, constants],
		);

		if (loading) {
			return null;
		}

		return (
			<>
				{DEBUG_CONSTANTS.map((constant) => (
					<TableListRow key={constant} label={constant} alignMiddle>
						<Switch
							tiny={true}
							flat={true}
							disabled={!!updating[constant]}
							name={constant}
							checked={constants[constant]}
							onChange={handleToggle}
						/>
					</TableListRow>
				))}
			</>
		);
	};

	hooks.addContent('SiteInfoOverview_TableList', (site) => (
		<DebugSwitches key="wordpress-supercharged-debug" site={site} />
	));
}
