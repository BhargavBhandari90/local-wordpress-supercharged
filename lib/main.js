"use strict";
/**
 * main.ts — Main Process Entry Point for the WordPress Supercharged Addon
 *
 * This file runs in Electron's main (Node.js) process. It is loaded by Local
 * when the addon is enabled. Its responsibilities are:
 *
 * 1. Reading WordPress debug constants (WP_DEBUG, WP_DEBUG_LOG, WP_DEBUG_DISPLAY)
 *    from a site's wp-config.php via WP-CLI.
 * 2. Writing debug constants back to wp-config.php via WP-CLI.
 * 3. Caching constant values on the SiteJSON object so that subsequent reads
 *    (e.g. when switching between sites) are instant and avoid spawning WP-CLI.
 * 4. Watching wp-config.php for external modifications (e.g. the user editing
 *    the file by hand) and pushing updated values to the renderer in real time.
 * 5. Suppressing the file watcher during self-initiated writes to prevent
 *    redundant re-fetches and UI flicker.
 *
 * Communication with the renderer process happens over four IPC channels:
 *   - supercharged:get-debug-constants  (renderer → main, async request/response)
 *   - supercharged:set-debug-constant   (renderer → main, async request/response)
 *   - supercharged:watch-site           (renderer → main, async request/response)
 *   - supercharged:unwatch-site         (renderer → main, async request/response)
 *   - supercharged:debug-constants-changed (main → renderer, fire-and-forget push)
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
Object.defineProperty(exports, "__esModule", { value: true });
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const LocalMain = __importStar(require("@getflywheel/local/main"));
/**
 * The three WordPress debug constants this addon manages.
 * Defined as a const tuple so it can be iterated and used as a type union.
 */
const DEBUG_CONSTANTS = ['WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY'];
/**
 * Returns the absolute filesystem path to wp-config.php for a given site.
 *
 * Local stores a site's WordPress files under `site.paths.webRoot`, which
 * typically resolves to something like:
 *   ~/Local Sites/<site-name>/app/public/
 *
 * @param site — The Local Site object.
 * @returns    — Absolute path to wp-config.php (e.g. "/Users/.../app/public/wp-config.php").
 */
function getWpConfigPath(site) {
    return path.join(site.paths.webRoot, 'wp-config.php');
}
/**
 * Returns the last-modified time (in milliseconds) of wp-config.php for a site.
 *
 * This is used for cache invalidation: if the file's mtime is newer than
 * `SuperchargedCache.cachedAt`, the cache is considered stale.
 *
 * Uses `fs.statSync` because it's a single synchronous stat call (~0.1ms),
 * which is far cheaper than spawning three WP-CLI processes.
 *
 * @param site — The Local Site object.
 * @returns    — The file's mtimeMs, or 0 if the file doesn't exist or can't be read.
 */
function getWpConfigMtime(site) {
    try {
        return fs.statSync(getWpConfigPath(site)).mtimeMs;
    }
    catch (_a) {
        return 0;
    }
}
/**
 * Fetches the current values of all three debug constants from wp-config.php
 * by running `wp config get <constant> --path=<site_path>` for each one.
 *
 * WordPress stores these as PHP constants via `define()`. The WP-CLI `config get`
 * command reads the raw PHP value:
 *   - `define('WP_DEBUG', true)`  → WP-CLI returns "1"
 *   - `define('WP_DEBUG', false)` → WP-CLI returns "" (empty string)
 *   - Constant not defined        → WP-CLI throws / returns null
 *
 * Each constant is evaluated as a boolean:
 *   - "1" or "true" (case-insensitive) → true
 *   - Anything else (empty, null, error) → false
 *
 * @param wpCli — The WpCli service instance from Local's service container.
 * @param site  — The Local Site object.
 * @returns     — A DebugCache mapping each constant name to its boolean value.
 */
function fetchDebugConstants(wpCli, site) {
    return __awaiter(this, void 0, void 0, function* () {
        const results = {};
        for (const constant of DEBUG_CONSTANTS) {
            try {
                // Run: wp config get WP_DEBUG --path=/path/to/site
                // The { ignoreErrors: true } option prevents WP-CLI from throwing on
                // non-critical errors (e.g. warnings from plugins during bootstrap).
                const value = yield wpCli.run(site, ['config', 'get', constant, `--path=${site.path}`], { ignoreErrors: true });
                // Normalize the raw string output to a boolean.
                // WP-CLI returns "1" for `true` and "" for `false`.
                // We also handle the literal string "true" for robustness.
                results[constant] = (value === null || value === void 0 ? void 0 : value.trim()) === '1' || (value === null || value === void 0 ? void 0 : value.trim().toLowerCase()) === 'true';
            }
            catch (e) {
                // If the constant is not defined in wp-config.php at all, WP-CLI
                // will exit with an error. We treat this as `false`.
                results[constant] = false;
            }
        }
        return results;
    });
}
/**
 * Persists the debug constant cache onto the SiteJSON object via Local's
 * `siteData.updateSite()` method.
 *
 * This writes a custom `superchargedAddon` property onto the site's JSON data,
 * which Local persists to disk in its site database (site.json). The data
 * survives app restarts and is available immediately when the site is loaded,
 * avoiding the need to spawn WP-CLI on every site switch.
 *
 * The `cachedAt` timestamp is set to `Date.now()` so that future reads can
 * compare it against wp-config.php's mtime for staleness detection.
 *
 * @param siteData — The SiteDataService instance from Local's service container.
 * @param siteId   — The unique identifier of the site to update.
 * @param cache    — The debug constant values to persist.
 */
function updateCache(siteData, siteId, cache) {
    siteData.updateSite(siteId, {
        id: siteId,
        superchargedAddon: {
            debugConstants: cache,
            cachedAt: Date.now(),
        },
    });
}
/**
 * The addon's main process entry point. Called by Local when the addon is loaded.
 *
 * Receives the AddonMainContext which provides access to Electron APIs, the
 * filesystem, storage, hooks, and the environment. This function sets up all
 * IPC listeners and the file-watching infrastructure.
 *
 * @param context — The AddonMainContext provided by Local, containing electron,
 *                  environment, fileSystem, hooks, storage, and other utilities.
 */
function default_1(context) {
    /**
     * Destructure the services we need from Local's Awilix-based service container.
     *
     * - wpCli:       WP-CLI wrapper — runs `wp` commands against a site.
     * - siteData:    CRUD service for site data — used to read/write the cache
     *                on the SiteJSON object.
     * - localLogger: Winston-based logger — used to create a child logger with
     *                addon-specific metadata for structured logging.
     */
    const { wpCli, siteData, localLogger } = LocalMain.getServiceContainer().cradle;
    /**
     * Create a child logger that tags all log entries with the addon name and
     * thread. Log output appears in Local's log file, e.g.:
     *   {"thread":"main","addon":"wordpress-supercharged","level":"info","message":"..."}
     */
    const logger = localLogger.child({
        thread: 'main',
        addon: 'wordpress-supercharged',
    });
    /**
     * Active file watchers, keyed by siteId.
     *
     * Each watcher monitors the site's wp-config.php for external changes using
     * OS-level file system events (FSEvents on macOS, inotify on Linux).
     * Watchers are created when the renderer mounts the DebugSwitches component
     * and closed when it unmounts (i.e. the user navigates away from the site).
     */
    const watchers = new Map();
    /**
     * Guard set to prevent the file watcher from firing during self-initiated
     * writes (i.e. when the addon itself runs `wp config set`).
     *
     * Without this guard, toggling a switch would cause:
     *   1. Optimistic UI update
     *   2. `wp config set` modifies wp-config.php
     *   3. `fs.watch` fires → re-fetches → pushes stale/intermediate values
     *   4. UI flickers (enable → disable → enable)
     *
     * The siteId is added to this set before writing and removed 500ms after
     * the write completes, giving the OS time to flush the file change event.
     */
    const selfWriting = new Set();
    /**
     * Starts an `fs.watch` file watcher on wp-config.php for the given site.
     *
     * When an external change is detected (and the addon is not currently writing
     * to the file), this function:
     *   1. Re-fetches all debug constants via WP-CLI.
     *   2. Updates the cache on the SiteJSON object.
     *   3. Pushes the new values to the renderer via a fire-and-forget IPC event.
     *
     * If a watcher already exists for this site, the function is a no-op.
     * If the file doesn't exist or can't be watched, the error is logged and
     * the function returns silently (the addon still works, just without
     * live-update support for that site).
     *
     * @param siteId — The unique identifier of the site to watch.
     */
    function watchSite(siteId) {
        // Prevent duplicate watchers for the same site.
        if (watchers.has(siteId)) {
            return;
        }
        const site = siteData.getSite(siteId);
        const configPath = getWpConfigPath(site);
        try {
            const watcher = fs.watch(configPath, (eventType) => __awaiter(this, void 0, void 0, function* () {
                // Only react to content changes, not renames or other events.
                if (eventType !== 'change') {
                    return;
                }
                // Skip if the addon itself is currently writing to this file.
                // This prevents the watcher from triggering a redundant re-fetch
                // and pushing intermediate state to the renderer.
                if (selfWriting.has(siteId)) {
                    return;
                }
                logger.info(`wp-config.php changed externally for site ${siteId}, refreshing`);
                // Re-read the site from siteData to get the latest state
                // (in case other properties have changed concurrently).
                const freshSite = siteData.getSite(siteId);
                // Fetch the current values of all debug constants from wp-config.php.
                const results = yield fetchDebugConstants(wpCli, freshSite);
                // Persist the new values to the cache.
                updateCache(siteData, siteId, results);
                // Push the updated values to the renderer process so the UI
                // updates in real time without the user needing to refresh.
                LocalMain.sendIPCEvent('supercharged:debug-constants-changed', siteId, results);
            }));
            watchers.set(siteId, watcher);
        }
        catch (e) {
            logger.warn(`Could not watch wp-config.php for site ${siteId}: ${e}`);
        }
    }
    /**
     * IPC Channel: supercharged:watch-site
     *
     * Called by the renderer when the DebugSwitches component mounts (i.e. the
     * user navigates to a site's Overview page). Starts a file watcher on
     * wp-config.php so external changes are detected and pushed to the UI.
     *
     * @param siteId — The ID of the site to start watching.
     */
    LocalMain.addIpcAsyncListener('supercharged:watch-site', (siteId) => __awaiter(this, void 0, void 0, function* () {
        watchSite(siteId);
    }));
    /**
     * IPC Channel: supercharged:unwatch-site
     *
     * Called by the renderer when the DebugSwitches component unmounts (i.e. the
     * user navigates away from the site). Closes the file watcher to free OS
     * resources and prevent stale callbacks.
     *
     * @param siteId — The ID of the site to stop watching.
     */
    LocalMain.addIpcAsyncListener('supercharged:unwatch-site', (siteId) => __awaiter(this, void 0, void 0, function* () {
        const watcher = watchers.get(siteId);
        if (watcher) {
            watcher.close();
            watchers.delete(siteId);
        }
    }));
    /**
     * IPC Channel: supercharged:get-debug-constants
     *
     * Called by the renderer on component mount to retrieve the current values
     * of all three debug constants. Implements a cache-first strategy:
     *
     * 1. Check if cached values exist on the SiteJSON object.
     * 2. If cached, compare `cachedAt` against wp-config.php's mtime.
     *    - If the cache is fresh (cachedAt >= mtime), return cached values
     *      immediately — no WP-CLI calls needed.
     *    - If the cache is stale (file was modified externally since last cache),
     *      fall through to step 3.
     * 3. If no cache or stale cache: fetch all constants via WP-CLI, persist
     *    the results to the cache, and return them.
     *
     * @param siteId — The ID of the site to fetch constants for.
     * @returns      — A DebugCache object: { WP_DEBUG: bool, WP_DEBUG_LOG: bool, WP_DEBUG_DISPLAY: bool }
     */
    LocalMain.addIpcAsyncListener('supercharged:get-debug-constants', (siteId) => __awaiter(this, void 0, void 0, function* () {
        const site = siteData.getSite(siteId);
        // Read the cached data from the SiteJSON object.
        // The `superchargedAddon` property is a custom field written by this addon;
        // it doesn't exist in the official SiteJSON type, hence the `as any` cast.
        const cached = site.superchargedAddon;
        // Cache hit: cached values exist and wp-config.php hasn't been modified
        // since we last wrote the cache. Return immediately without spawning WP-CLI.
        if ((cached === null || cached === void 0 ? void 0 : cached.debugConstants) && cached.cachedAt >= getWpConfigMtime(site)) {
            logger.info(`Returning cached debug constants for site ${siteId}`);
            return cached.debugConstants;
        }
        // Cache miss or stale: fetch fresh values from wp-config.php via WP-CLI.
        const results = yield fetchDebugConstants(wpCli, site);
        // Persist the fresh values to the cache for future reads.
        updateCache(siteData, siteId, results);
        logger.info(`Fetched and cached debug constants for site ${siteId}: ${JSON.stringify(results)}`);
        return results;
    }));
    /**
     * IPC Channel: supercharged:set-debug-constant
     *
     * Called by the renderer when the user toggles a switch. Writes a single
     * debug constant to wp-config.php via WP-CLI and updates the cache.
     *
     * The write flow is:
     * 1. Add the siteId to the `selfWriting` guard set so that the file watcher
     *    ignores the upcoming file change event.
     * 2. Run `wp config set <constant> <value> --raw --add --path=<site_path>`.
     *    - `--raw` tells WP-CLI to write the value as a raw PHP expression
     *      (i.e. `true`/`false` without quotes).
     *    - `--add` creates the constant if it doesn't already exist.
     * 3. Remove the siteId from `selfWriting` after a 500ms delay. The delay
     *    ensures the OS has time to deliver the file change event to `fs.watch`
     *    before we re-enable the watcher. Without this delay, the watcher could
     *    fire after the guard is removed and cause UI flicker.
     * 4. Merge the new value into the existing cache and persist it. We merge
     *    rather than overwrite so that the other two constants retain their
     *    cached values.
     *
     * @param siteId   — The ID of the site to update.
     * @param constant — The constant name (e.g. "WP_DEBUG").
     * @param value    — The new boolean value to set.
     * @returns        — { success: true } on success.
     */
    LocalMain.addIpcAsyncListener('supercharged:set-debug-constant', (siteId, constant, value) => __awaiter(this, void 0, void 0, function* () {
        const site = siteData.getSite(siteId);
        const wpValue = value ? 'true' : 'false';
        // Mark this site as "self-writing" to suppress the file watcher.
        selfWriting.add(siteId);
        try {
            // Run: wp config set WP_DEBUG true --raw --add --path=/path/to/site
            yield wpCli.run(site, ['config', 'set', constant, wpValue, '--raw', '--add', `--path=${site.path}`]);
        }
        finally {
            // Remove the guard after 500ms to let the OS flush the file event.
            // Uses `finally` so the guard is always removed, even if WP-CLI fails.
            setTimeout(() => selfWriting.delete(siteId), 500);
        }
        // Merge the updated constant into the existing cache.
        // Spread the existing cached values (if any) so the other constants
        // are preserved, then override the one that was just changed.
        const cached = site.superchargedAddon;
        const updatedCache = Object.assign(Object.assign({}, cached === null || cached === void 0 ? void 0 : cached.debugConstants), { [constant]: value });
        updateCache(siteData, siteId, updatedCache);
        logger.info(`Set ${constant} to ${wpValue} for site ${siteId} and updated cache`);
        return { success: true };
    }));
}
exports.default = default_1;
//# sourceMappingURL=main.js.map