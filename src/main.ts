import * as Local from '@getflywheel/local';
import * as LocalMain from '@getflywheel/local/main';

const DEBUG_CONSTANTS = ['WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY'] as const;

type DebugCache = Record<string, boolean>;

async function fetchDebugConstants(
	wpCli: LocalMain.Services.WpCli,
	site: Local.Site,
): Promise<DebugCache> {
	const results: DebugCache = {};

	for (const constant of DEBUG_CONSTANTS) {
		try {
			const value = await wpCli.run(site, ['config', 'get', constant, `--path=${site.path}`], { ignoreErrors: true });
			results[constant] = value?.trim() === '1' || value?.trim().toLowerCase() === 'true';
		} catch (e) {
			results[constant] = false;
		}
	}

	return results;
}

function updateCache(
	siteData: LocalMain.Services.SiteDataService,
	siteId: string,
	cache: DebugCache,
): void {
	siteData.updateSite(siteId, {
		id: siteId,
		superchargedAddon: { debugConstants: cache },
	} as Partial<Local.SiteJSON>);
}

export default function (context: LocalMain.AddonMainContext): void {
	const { wpCli, siteData, localLogger } = LocalMain.getServiceContainer().cradle;

	const logger = localLogger.child({
		thread: 'main',
		addon: 'wordpress-supercharged',
	});

	LocalMain.addIpcAsyncListener(
		'supercharged:get-debug-constants',
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = (site as any).superchargedAddon?.debugConstants as DebugCache | undefined;

			if (cached) {
				logger.info(`Returning cached debug constants for site ${siteId}`);
				return cached;
			}

			const results = await fetchDebugConstants(wpCli, site);
			updateCache(siteData, siteId, results);

			logger.info(`Fetched and cached debug constants for site ${siteId}: ${JSON.stringify(results)}`);
			return results;
		},
	);

	LocalMain.addIpcAsyncListener(
		'supercharged:set-debug-constant',
		async (siteId: string, constant: string, value: boolean) => {
			const site = siteData.getSite(siteId);
			const wpValue = value ? 'true' : 'false';

			await wpCli.run(site, ['config', 'set', constant, wpValue, '--raw', '--add', `--path=${site.path}`]);

			const cached = (site as any).superchargedAddon?.debugConstants as DebugCache | undefined;
			const updatedCache = { ...cached, [constant]: value };
			updateCache(siteData, siteId, updatedCache);

			logger.info(`Set ${constant} to ${wpValue} for site ${siteId} and updated cache`);
			return { success: true };
		},
	);
}
