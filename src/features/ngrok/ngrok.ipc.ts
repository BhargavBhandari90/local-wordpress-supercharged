/**
 * ngrok.ipc.ts -- IPC handler registration for the ngrok feature.
 *
 * Channels:
 *   - GET_NGROK: read cached state
 *   - APPLY_NGROK: save URL to mapping (no wp-config.php changes)
 *   - ENABLE_NGROK: enable/disable the feature (writes/removes wp-config.php constants)
 *   - CLEAR_NGROK: clear URL and remove mapping
 *   - START_NGROK_PROCESS: spawn the ngrok CLI for a site
 *   - STOP_NGROK_PROCESS: kill the ngrok CLI for a site
 *   - GET_NGROK_PROCESS_STATUS: return 'running' or 'stopped'
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
import {
	startNgrokProcess,
	stopNgrokProcess,
	getNgrokProcessStatus,
} from './ngrok.process';

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
	 *   1. Resolve URL collisions (disable conflicting sites, kill their
	 *      ngrok processes, remove wp-config.php constants, notify renderer).
	 *   2. Set WP_HOME and WP_SITEURL on the current site.
	 *   3. Update cache.
	 *
	 * When disabling:
	 *   1. Kill any running ngrok process.
	 *   2. Remove WP_HOME and WP_SITEURL from the current site.
	 *   3. Update cache (URL preserved).
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

					stopNgrokProcess(conflictId);
					await removeNgrokConstants(wpCli, conflictSite);
					writeNgrokCache(siteData, conflictId, {
						enabled: false,
						url: conflictNgrok?.url ?? '',
					});

					logger.info(`Disabled ngrok on site ${conflictId} due to URL collision with site ${siteId}`);
					LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_CHANGED, conflictId, false);
					LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_PROCESS_STATUS_CHANGED, conflictId, 'stopped');
				}

				await setNgrokConstants(wpCli, site, url);
				writeNgrokCache(siteData, siteId, { enabled: true, url });
				logger.info(`Enabled ngrok for site ${siteId} with URL ${url}`);
			} else {
				stopNgrokProcess(siteId);
				await removeNgrokConstants(wpCli, site);
				writeNgrokCache(siteData, siteId, { enabled: false, url });
				logger.info(`Disabled ngrok for site ${siteId}`);
			}
		},
	);

	/**
	 * Clear the ngrok URL and remove the mapping.
	 * Kills any running ngrok process first.
	 * If ngrok was enabled, removes the constants from wp-config.php.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.CLEAR_NGROK,
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = readNgrokCache(site);

			stopNgrokProcess(siteId);

			if (cached?.enabled) {
				await removeNgrokConstants(wpCli, site);
			}

			clearNgrokCache(siteData, siteId);
			logger.info(`Cleared ngrok mapping for site ${siteId}`);
		},
	);

	/**
	 * Start the ngrok CLI process for a site.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.START_NGROK_PROCESS,
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = readNgrokCache(site);

			if (!cached?.url) {
				throw new Error(`No ngrok URL configured for site ${siteId}`);
			}

			const siteDomain = (site as any).domain as string;
			const httpPort = (site as any).httpPort ?? 80;

			const result = await startNgrokProcess(siteId, cached.url, siteDomain, httpPort, (exitedSiteId, error) => {
				LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_PROCESS_STATUS_CHANGED, exitedSiteId, 'stopped', error);
				if (error) {
					logger.warn(`ngrok process failed for site ${exitedSiteId}: ${error}`);
				} else {
					logger.info(`ngrok process exited for site ${exitedSiteId}`);
				}
			});

			LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_PROCESS_STATUS_CHANGED, siteId, 'running');

			if (result === 'already-running') {
				logger.info(`ngrok tunnel already active for site ${siteId}, skipped spawning`);
			} else {
				logger.info(`Started ngrok process for site ${siteId}`);
			}
		},
	);

	/**
	 * Stop the ngrok CLI process for a site.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.STOP_NGROK_PROCESS,
		async (siteId: string) => {
			stopNgrokProcess(siteId);
			LocalMain.sendIPCEvent(IPC_CHANNELS.NGROK_PROCESS_STATUS_CHANGED, siteId, 'stopped');
			logger.info(`Stopped ngrok process for site ${siteId}`);
		},
	);

	/**
	 * Get the current ngrok process status for a site.
	 * Checks both the in-memory Map and the ngrok agent API.
	 * Passes the expected backend target so that a tunnel pointing
	 * to a different site is not reported as "running" for this one.
	 */
	LocalMain.addIpcAsyncListener(
		IPC_CHANNELS.GET_NGROK_PROCESS_STATUS,
		async (siteId: string) => {
			const site = siteData.getSite(siteId);
			const cached = readNgrokCache(site);
			const siteDomain = (site as any).domain as string;
			const httpPort = (site as any).httpPort ?? 80;
			const target = siteDomain ? `${siteDomain}:${httpPort}` : undefined;
			return getNgrokProcessStatus(siteId, cached?.url, target);
		},
	);
}
