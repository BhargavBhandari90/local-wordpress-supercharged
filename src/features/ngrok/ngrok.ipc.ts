/**
 * ngrok.ipc.ts -- IPC handler registration for the ngrok feature.
 *
 * Four channels:
 *   - GET_NGROK: read cached state
 *   - APPLY_NGROK: save URL to mapping (no wp-config.php changes)
 *   - ENABLE_NGROK: enable/disable the feature (writes/removes wp-config.php constants)
 *   - CLEAR_NGROK: clear URL and remove mapping
 */

import * as LocalMain from '@getflywheel/local/main';
import { IPC_CHANNELS } from '../../shared/types';
import {
	setNgrokConstants,
	removeNgrokConstants,
	readNgrokCache,
	writeNgrokCache,
	clearNgrokCache,
	findConflictingSites,
} from './ngrok.service';

export interface NgrokIpcDeps {
	wpCli: LocalMain.Services.WpCli;
	siteData: LocalMain.Services.SiteDataService;
	logger: { info: (msg: string) => void; warn: (msg: string) => void };
}

export function registerNgrokIpc(deps: NgrokIpcDeps): void {
	const { wpCli, siteData, logger } = deps;

	/**
	 * Get the current ngrok state for a site.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.GET_NGROK,
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = readNgrokCache(site);
			return {
				enabled: cached?.enabled ?? false,
				url: cached?.url ?? '',
			};
		},
	);

	/**
	 * Save the ngrok URL to the SiteJSON mapping.
	 * Does NOT touch wp-config.php. Called when the user clicks "Apply".
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.APPLY_NGROK,
		async (siteId: string, url: string) => {
			writeNgrokCache(siteData, siteId, { enabled: false, url });
			logger.info(`Saved ngrok URL for site ${siteId}: ${url}`);
		},
	);

	/**
	 * Enable or disable ngrok for a site.
	 *
	 * When enabling:
	 *   1. Resolve URL collisions (disable conflicting sites, remove their
	 *      wp-config.php constants, preserve their URLs, notify renderer).
	 *   2. Set WP_HOME and WP_SITEURL on the current site.
	 *   3. Update cache.
	 *
	 * When disabling:
	 *   1. Remove WP_HOME and WP_SITEURL from the current site.
	 *   2. Update cache (URL preserved).
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.ENABLE_NGROK,
		async (siteId: string, enabled: boolean, url: string) => {
			const site = siteData.getSite(siteId);

			if (enabled) {
				const conflicting = findConflictingSites(siteData, url, siteId);

				for (const conflictId of conflicting) {
					const conflictSite = siteData.getSite(conflictId);
					const conflictNgrok = readNgrokCache(conflictSite);

					await removeNgrokConstants(wpCli, conflictSite);
					writeNgrokCache(siteData, conflictId, {
						enabled: false,
						url: conflictNgrok?.url ?? '',
					});

					logger.info(`Disabled ngrok on site ${conflictId} due to URL collision with site ${siteId}`);
					LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_CHANGED, conflictId, false);
				}

				await setNgrokConstants(wpCli, site, url);
				writeNgrokCache(siteData, siteId, { enabled: true, url });
				logger.info(`Enabled ngrok for site ${siteId} with URL ${url}`);
			} else {
				await removeNgrokConstants(wpCli, site);
				writeNgrokCache(siteData, siteId, { enabled: false, url });
				logger.info(`Disabled ngrok for site ${siteId}`);
			}
		},
	);

	/**
	 * Clear the ngrok URL and remove the mapping.
	 * If ngrok was enabled, removes the constants from wp-config.php first.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.CLEAR_NGROK,
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = readNgrokCache(site);

			if (cached?.enabled) {
				await removeNgrokConstants(wpCli, site);
			}

			clearNgrokCache(siteData, siteId);
			logger.info(`Cleared ngrok mapping for site ${siteId}`);
		},
	);
}
