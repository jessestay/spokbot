// servers/desktop/paths.js — path resolution for the desktop MCP server.
//
// Kept dependency-free (no MCP SDK) so the resolution is unit-testable
// on its own. US-FW-002: the desktop-run client path was a hardcoded
// per-machine literal; it now resolves exactly like utils/agentTools.js
// — explicit DESKTOP_RUN_CLIENT env wins, otherwise the client lives in
// the operator's home workspace (os.homedir() anchor).
'use strict';

const os = require('os');
const path = require('path');

function desktopRunClient() {
  return process.env.DESKTOP_RUN_CLIENT ||
    path.join(os.homedir(), 'workspace', 'desktop-agent', 'bin', 'desktop-run');
}

module.exports = { desktopRunClient };
