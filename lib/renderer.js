"use strict";
/**
 * renderer.tsx — Renderer Process Entry Point for the WordPress Supercharged Addon
 *
 * This file runs in Electron's renderer (browser) process inside Local's main
 * window. It is loaded by Local when the addon is enabled. Its responsibilities are:
 *
 * 1. Injecting three toggle switches (WP_DEBUG, WP_DEBUG_LOG, WP_DEBUG_DISPLAY)
 *    into the Site Info Overview page using Local's content hook system.
 * 2. Fetching the current constant values from the main process on mount.
 * 3. Optimistically updating the UI when the user toggles a switch, with
 *    automatic rollback on failure.
 * 4. Disabling individual switches while their WP-CLI write is in flight.
 * 5. Listening for external wp-config.php changes (pushed from the main process
 *    via IPC) and updating the UI in real time.
 * 6. Managing the file watcher lifecycle — starting it on mount, stopping it
 *    on unmount — to avoid resource leaks.
 *
 * The component communicates with the main process over these IPC channels:
 *   - supercharged:get-debug-constants    (async request → returns DebugState)
 *   - supercharged:set-debug-constant     (async request → returns { success })
 *   - supercharged:watch-site             (async request → starts file watcher)
 *   - supercharged:unwatch-site           (async request → stops file watcher)
 *   - supercharged:debug-constants-changed (event listener → receives pushed updates)
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
const LocalRenderer = __importStar(require("@getflywheel/local/renderer"));
const electron_1 = require("electron");
const local_components_1 = require("@getflywheel/local-components");
const local_components_2 = require("@getflywheel/local-components");
/**
 * The three WordPress debug constants this addon manages.
 * Defined as a const tuple so it can be iterated and used as a type union.
 */
const DEBUG_CONSTANTS = ['WP_DEBUG', 'WP_DEBUG_LOG', 'WP_DEBUG_DISPLAY'];
/**
 * The initial state for all debug constants before the real values are fetched.
 * All constants default to `false` (disabled).
 */
const DEFAULT_STATE = {
    WP_DEBUG: false,
    WP_DEBUG_LOG: false,
    WP_DEBUG_DISPLAY: false,
};
/**
 * The addon's renderer process entry point. Called by Local when the addon is loaded.
 *
 * Receives the AddonRendererContext which provides access to React (the same
 * instance Local uses), React Router, the MobX root store, the hooks system,
 * and all the same context properties as the main entry point.
 *
 * This function registers a content hook on `SiteInfoOverview_TableList` which
 * causes the DebugSwitches component to render inside the table list on every
 * site's Overview tab.
 *
 * @param context — The AddonRendererContext provided by Local, containing React,
 *                  ReactRouter, store (RootStore), hooks (HooksRenderer), and
 *                  the same environment/electron/storage utilities as main.
 */
function default_1(context) {
    /**
     * Destructure React and hooks from the context.
     *
     * IMPORTANT: We use `context.React` rather than importing React directly
     * because the addon's bundled React could be a different version than the
     * one Local uses internally. Using the context-provided instance ensures
     * hooks and components work correctly within Local's React tree.
     */
    const { React, hooks } = context;
    const { useState, useEffect, useCallback } = React;
    /**
     * DebugSwitches Component
     *
     * A functional React component that renders three toggle switches for
     * WordPress debug constants. Each switch is wrapped in a TableListRow
     * to match Local's native UI style on the Site Info Overview page.
     *
     * Lifecycle:
     *   Mount  → Fetch current values from main process
     *          → Start wp-config.php file watcher
     *          → Subscribe to external change events
     *   Update → Optimistic toggle with disabled state during write
     *   Unmount → Unsubscribe from change events
     *           → Stop file watcher
     *
     * @param props.site — The site object with at least an `id` property.
     */
    const DebugSwitches = ({ site }) => {
        /**
         * The current boolean state of each debug constant.
         * Initialized to DEFAULT_STATE and updated from:
         *   - The initial fetch on mount
         *   - Optimistic updates when the user toggles a switch
         *   - External change events pushed from the main process
         */
        const [constants, setConstants] = useState(DEFAULT_STATE);
        /**
         * Whether the initial fetch is still in progress.
         * While true, the component renders nothing (returns null) to avoid
         * showing stale default values before the real state is known.
         */
        const [loading, setLoading] = useState(true);
        /**
         * Per-constant updating state. Maps constant names to booleans indicating
         * whether a WP-CLI write is currently in flight for that constant.
         * When true, the corresponding Switch is rendered in the disabled state
         * to prevent double-toggling and provide visual feedback.
         *
         * Each constant is tracked independently so toggling WP_DEBUG doesn't
         * disable the WP_DEBUG_LOG switch.
         */
        const [updating, setUpdating] = useState({});
        /**
         * Effect: Initial fetch, watcher setup, and external change subscription.
         *
         * Runs when the component mounts or when site.id changes (i.e. the user
         * switches to a different site). The cleanup function runs on unmount or
         * before the effect re-runs with a new site.id.
         *
         * Steps on mount:
         *   1. Fetch current constant values from the main process via IPC.
         *      The main process returns cached values if available, or fetches
         *      fresh values via WP-CLI.
         *   2. Tell the main process to start watching wp-config.php for changes.
         *   3. Subscribe to the `supercharged:debug-constants-changed` IPC event
         *      so that external file edits update the UI in real time.
         *
         * Steps on cleanup (unmount or site change):
         *   1. Remove the IPC event listener to prevent memory leaks and stale
         *      updates to an unmounted component.
         *   2. Tell the main process to stop watching wp-config.php to free OS
         *      resources (file descriptors / FSEvents handles).
         */
        useEffect(() => {
            // Step 1: Fetch the current state of all debug constants.
            // Uses the async IPC channel which returns a Promise.
            // On success, update the component state with the real values.
            // On failure, fall back to DEFAULT_STATE (all false).
            // In either case, set loading to false so the component renders.
            LocalRenderer.ipcAsync('supercharged:get-debug-constants', site.id)
                .then((result) => setConstants(result))
                .catch(() => setConstants(DEFAULT_STATE))
                .finally(() => setLoading(false));
            // Step 2: Start the file watcher in the main process.
            // This enables real-time UI updates when wp-config.php is edited
            // externally (e.g. in a text editor or by another tool).
            LocalRenderer.ipcAsync('supercharged:watch-site', site.id);
            // Step 3: Subscribe to external change events.
            // The main process sends this event when its fs.watch detects a
            // change to wp-config.php that was NOT initiated by this addon.
            // The event payload includes the siteId and the updated DebugState.
            const handleExternalChange = (_event, siteId, updated) => {
                // Only update if the event is for the site we're currently viewing.
                // Multiple sites could theoretically have active watchers during
                // transition periods.
                if (siteId === site.id) {
                    setConstants(updated);
                }
            };
            electron_1.ipcRenderer.on('supercharged:debug-constants-changed', handleExternalChange);
            // Cleanup function: runs on unmount or before re-running with new site.id.
            return () => {
                // Remove the specific listener to prevent memory leaks.
                // Uses removeListener (not removeAllListeners) to avoid interfering
                // with other potential listeners on the same channel.
                electron_1.ipcRenderer.removeListener('supercharged:debug-constants-changed', handleExternalChange);
                // Tell the main process to close the file watcher for this site.
                LocalRenderer.ipcAsync('supercharged:unwatch-site', site.id);
            };
        }, [site.id]);
        /**
         * Handles toggling a debug constant switch.
         *
         * Called by the Switch component's onChange prop with the signature:
         *   (name: string, newCheckedValue: boolean) => void
         *
         * Implements an optimistic update pattern:
         *   1. Immediately update the UI to reflect the new value (responsive feel).
         *   2. Mark the constant as "updating" to disable the switch.
         *   3. Send the new value to the main process via IPC.
         *   4. If the IPC call fails, revert the UI to the previous value.
         *   5. In all cases, re-enable the switch by clearing the "updating" flag.
         *
         * Dependencies: [site.id, constants]
         *   - site.id: ensures we send to the correct site.
         *   - constants: ensures `previous` captures the correct pre-toggle value
         *     for rollback purposes.
         */
        const handleToggle = useCallback((name, value) => __awaiter(this, void 0, void 0, function* () {
            // Capture the current value before the optimistic update so we
            // can revert to it if the IPC call fails.
            const previous = constants[name];
            // Step 1: Optimistic UI update — immediately show the new state.
            setConstants((prev) => (Object.assign(Object.assign({}, prev), { [name]: value })));
            // Step 2: Disable the switch to prevent double-toggling while
            // the WP-CLI command is running in the main process.
            setUpdating((prev) => (Object.assign(Object.assign({}, prev), { [name]: true })));
            try {
                // Step 3: Send the new value to the main process.
                // The main process will run `wp config set` and update the cache.
                yield LocalRenderer.ipcAsync('supercharged:set-debug-constant', site.id, name, value);
            }
            catch (e) {
                // Step 4: Rollback — revert the optimistic update on failure.
                // This ensures the UI accurately reflects the actual state of
                // wp-config.php if the WP-CLI command failed.
                setConstants((prev) => (Object.assign(Object.assign({}, prev), { [name]: previous })));
            }
            finally {
                // Step 5: Re-enable the switch regardless of success or failure.
                setUpdating((prev) => (Object.assign(Object.assign({}, prev), { [name]: false })));
            }
        }), [site.id, constants]);
        // Don't render anything while the initial fetch is in progress.
        // This avoids showing switches in the default "off" state before
        // the real values are known, which would cause a visual flash.
        if (loading) {
            return null;
        }
        /**
         * Render three rows, one for each debug constant.
         *
         * Each row consists of:
         *   - TableListRow: A Local UI component that renders as a <li> in the
         *     site overview table list. The `label` prop displays the constant
         *     name as a bold label on the left. The `alignMiddle` prop vertically
         *     centers the content.
         *   - Switch: A Local UI toggle component. Props:
         *     - tiny: Renders a smaller 20x48px variant.
         *     - flat: Removes box-shadow for a flatter look.
         *     - disabled: Prevents interaction while a write is in flight.
         *     - name: Passed back to onChange as the first argument.
         *     - checked: The current boolean state of the constant.
         *     - onChange: Called with (name, newValue) when toggled.
         */
        return (React.createElement(React.Fragment, null, DEBUG_CONSTANTS.map((constant) => (React.createElement(local_components_1.TableListRow, { key: constant, label: constant, alignMiddle: true },
            React.createElement(local_components_2.Switch, { tiny: true, flat: true, disabled: !!updating[constant], name: constant, checked: constants[constant], onChange: handleToggle }))))));
    };
    /**
     * Register the DebugSwitches component with Local's content hook system.
     *
     * `SiteInfoOverview_TableList` is a content hook that fires when Local
     * renders the table list on a site's Overview tab. The callback receives
     * the current site object and must return a React element with a unique
     * `key` prop (since content hooks collect elements into an array).
     *
     * This causes the three debug switches to appear as additional rows in
     * the site overview table, alongside built-in rows like Domain, SSL, etc.
     */
    hooks.addContent('SiteInfoOverview_TableList', (site) => (React.createElement(DebugSwitches, { key: "wordpress-supercharged-debug", site: site })));
}
exports.default = default_1;
//# sourceMappingURL=renderer.js.map