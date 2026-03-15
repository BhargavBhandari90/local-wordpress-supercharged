"use strict";
/**
 * ngrok.ipc.ts -- IPC handler registration for the ngrok feature.
 *
 * Four channels:
 *   - GET_NGROK: read cached state
 *   - APPLY_NGROK: save URL to mapping (no wp-config.php changes)
 *   - ENABLE_NGROK: enable/disable the feature (writes/removes wp-config.php constants)
 *   - CLEAR_NGROK: clear URL and remove mapping
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
exports.registerNgrokIpc = void 0;
const LocalMain = __importStar(require("@getflywheel/local/main"));
const types_1 = require("../../shared/types");
const ngrok_service_1 = require("./ngrok.service");
function registerNgrokIpc(deps) {
    const { wpCli, siteData, logger } = deps;
    /**
     * Get the current ngrok state for a site.
     */
    LocalMain.addIpcAsyncListener(types_1.IPC_CHANNELS.GET_NGROK, (siteId) => __awaiter(this, void 0, void 0, function* () {
        var _a, _b;
        const site = siteData.getSite(siteId);
        const cached = (0, ngrok_service_1.readNgrokCache)(site);
        return {
            enabled: (_a = cached === null || cached === void 0 ? void 0 : cached.enabled) !== null && _a !== void 0 ? _a : false,
            url: (_b = cached === null || cached === void 0 ? void 0 : cached.url) !== null && _b !== void 0 ? _b : '',
        };
    }));
    /**
     * Save the ngrok URL to the SiteJSON mapping.
     * Does NOT touch wp-config.php. Called when the user clicks "Apply".
     */
    LocalMain.addIpcAsyncListener(types_1.IPC_CHANNELS.APPLY_NGROK, (siteId, url) => __awaiter(this, void 0, void 0, function* () {
        (0, ngrok_service_1.writeNgrokCache)(siteData, siteId, { enabled: false, url });
        logger.info(`Saved ngrok URL for site ${siteId}: ${url}`);
    }));
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
    LocalMain.addIpcAsyncListener(types_1.IPC_CHANNELS.ENABLE_NGROK, (siteId, enabled, url) => __awaiter(this, void 0, void 0, function* () {
        var _c;
        const site = siteData.getSite(siteId);
        if (enabled) {
            const conflicting = (0, ngrok_service_1.findConflictingSites)(siteData, url, siteId);
            for (const conflictId of conflicting) {
                const conflictSite = siteData.getSite(conflictId);
                const conflictNgrok = (0, ngrok_service_1.readNgrokCache)(conflictSite);
                yield (0, ngrok_service_1.removeNgrokConstants)(wpCli, conflictSite);
                (0, ngrok_service_1.writeNgrokCache)(siteData, conflictId, {
                    enabled: false,
                    url: (_c = conflictNgrok === null || conflictNgrok === void 0 ? void 0 : conflictNgrok.url) !== null && _c !== void 0 ? _c : '',
                });
                logger.info(`Disabled ngrok on site ${conflictId} due to URL collision with site ${siteId}`);
                LocalMain.sendIPCEvent(types_1.IPC_CHANNELS.NGROK_CHANGED, conflictId, false);
            }
            yield (0, ngrok_service_1.setNgrokConstants)(wpCli, site, url);
            (0, ngrok_service_1.writeNgrokCache)(siteData, siteId, { enabled: true, url });
            logger.info(`Enabled ngrok for site ${siteId} with URL ${url}`);
        }
        else {
            yield (0, ngrok_service_1.removeNgrokConstants)(wpCli, site);
            (0, ngrok_service_1.writeNgrokCache)(siteData, siteId, { enabled: false, url });
            logger.info(`Disabled ngrok for site ${siteId}`);
        }
    }));
    /**
     * Clear the ngrok URL and remove the mapping.
     * If ngrok was enabled, removes the constants from wp-config.php first.
     */
    LocalMain.addIpcAsyncListener(types_1.IPC_CHANNELS.CLEAR_NGROK, (siteId) => __awaiter(this, void 0, void 0, function* () {
        const site = siteData.getSite(siteId);
        const cached = (0, ngrok_service_1.readNgrokCache)(site);
        if (cached === null || cached === void 0 ? void 0 : cached.enabled) {
            yield (0, ngrok_service_1.removeNgrokConstants)(wpCli, site);
        }
        (0, ngrok_service_1.clearNgrokCache)(siteData, siteId);
        logger.info(`Cleared ngrok mapping for site ${siteId}`);
    }));
}
exports.registerNgrokIpc = registerNgrokIpc;
//# sourceMappingURL=ngrok.ipc.js.map