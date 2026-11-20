#!/usr/bin/env bash
# Server MCP token health: metadata expiry check first (its exit code is the
# service result), then the real MCP connectivity proof (jest suite, logged).
set -u
cd /home/ubuntu/workspace/macf/slack-agents
export HOME=/home/ubuntu/workspace/macf/engine-home

echo "--- jest MCP connectivity suite (server tree) ---"
timeout 600 npx jest engine/tests/mcp --forceExit 2>&1 | tail -40
echo "--- token-health.js (metadata) ---"
node engine/token-health.js
exit $?
