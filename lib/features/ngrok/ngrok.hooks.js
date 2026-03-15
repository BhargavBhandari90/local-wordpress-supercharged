"use strict";
/**
 * ngrok.hooks.tsx -- Renderer-process hook registrations for the ngrok feature.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerNgrokHooks = void 0;
const NgrokRow_1 = require("./NgrokRow");
function registerNgrokHooks(React, hooks) {
    const NgrokRow = (0, NgrokRow_1.createNgrokRow)(React);
    hooks.addContent('SiteInfoOverview_TableList', (site) => (React.createElement(NgrokRow, { key: "wordpress-supercharged-ngrok", site: site })));
}
exports.registerNgrokHooks = registerNgrokHooks;
//# sourceMappingURL=ngrok.hooks.js.map