// servers/finance-files/paths.js — path resolution for the finance-files
// MCP server.
//
// Kept dependency-free (no MCP SDK) so the resolution is unit-testable
// on its own. US-FW-002: the finance data dir was a hardcoded absolute
// path on the production server. It is instance data: explicit
// SPOKBOT_FINANCE_DIR env wins; otherwise it resolves under the
// engine's HOME workspace sandbox — $HOME/workspace/agent-sandbox/
// finance, which is exactly where production keeps it today (the
// engine spawns this server with HOME=<engine-home>).
'use strict';

const os = require('os');
const path = require('path');

function financeDir() {
  if (process.env.SPOKBOT_FINANCE_DIR) return process.env.SPOKBOT_FINANCE_DIR;
  return path.join(os.homedir(), 'workspace', 'agent-sandbox', 'finance');
}

module.exports = { financeDir };
