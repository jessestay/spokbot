'use strict';
// hands/servers/slack/launch.js — launcher for slack-mcp-server (korotovsky).
// Why: the capability audit spawns grants commands WITHOUT expanding ${VARS}
// from slack-agents/.env (it passes spec.env verbatim), and secrets must not
// live in grants.json. So the xoxp token is read from .env here at runtime.
// The server validates the token at startup, so a literal "${...}" placeholder
// (audit context) would kill it; a real env value (engine context) is kept.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const envPath = path.join(__dirname, '..', '..', '..', 'slack-agents', '.env');
const fileEnv = {};
try {
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([^#=]+)=(.*)$/);
    if (m) fileEnv[m[1].trim()] = m[2].trim();
  }
} catch (e) {
  console.error('slack launch: cannot read .env:', e.message);
  process.exit(1);
}
const fromEnv = process.env.SLACK_MCP_XOXP_TOKEN;
const tok = (fromEnv && !fromEnv.startsWith('${')) ? fromEnv : fileEnv.SLACK_MCP_XOXP_TOKEN;
if (!tok) {
  console.error('slack launch: SLACK_MCP_XOXP_TOKEN not available');
  process.exit(1);
}
const bin = path.join(__dirname, '..', '..', '..', 'hands', 'node_modules', '.bin', 'slack-mcp-server');
const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, SLACK_MCP_XOXP_TOKEN: tok },
});
child.on('exit', c => process.exit(c == null ? 1 : c));
process.on('SIGTERM', () => child.kill('SIGTERM'));
process.on('SIGINT', () => child.kill('SIGINT'));
