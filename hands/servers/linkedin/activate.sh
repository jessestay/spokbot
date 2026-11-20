#!/bin/bash
# MACF F10 LinkedIn activation — run AFTER a fresh LINKEDIN_ACCESS_TOKEN is in slack-agents/.env.
# 1) sanity: token must return 200 from LinkedIn /v2/userinfo
# 2) install + start the systemd unit for the patched server (hands/servers/linkedin)
# 3) flip grants.json linkedin entry to the mcp-remote bridge (backup first)
# 4) probe twice through engine/mcpClient.js in engine HOME context
set -u
cd /home/ubuntu/workspace/macf/slack-agents
TOK=$(grep '^LINKEDIN_ACCESS_TOKEN=' .env | cut -d= -f2-)
CODE=$(curl -s -o /dev/null -w '%{http_code}' https://api.linkedin.com/v2/userinfo -H "Authorization: Bearer $TOK")
echo "token check: HTTP $CODE"
[ "$CODE" = "200" ] || { echo "ABORT: token not valid yet"; exit 1; }
sudo cp /home/ubuntu/workspace/macf/hands/servers/linkedin/macf-linkedin-mcp.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now macf-linkedin-mcp
sleep 3
systemctl is-active macf-linkedin-mcp || { echo "ABORT: service not active"; exit 1; }
python3 - <<'PYEOF'
import json, shutil, datetime
p = '/home/ubuntu/workspace/macf/hands/grants.json'
ts = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
shutil.copy2(p, p + '.bak-' + ts + '-linkedin-activate')
g = json.load(open(p))
s = g['servers']['linkedin']
s['command'] = 'npx'
s['args'] = ['-y', 'mcp-remote@0.15.2', 'http://127.0.0.1:3421/mcp']
s['env'] = {}
s['note'] = ('LinkedIn via mcp-remote bridge to the local vahabcore server (hands/servers/linkedin, systemd macf-linkedin-mcp, port 3421) '
             'using LINKEDIN_ACCESS_TOKEN from slack-agents/.env (read by the service, not grants). Activated after the Nov 11, 2026 token renewal. '
             'Upstream v2.0.0 crashes on external SSE connects (shared McpServer singleton); MACF patch creates a fresh server per connection (server.js.orig-* backup alongside). '
             'Safe for posts; messaging NOT supported (account risk).')
json.dump(g, open(p, 'w'), indent=1)
print('grants flipped; backup:', p + '.bak-' + ts + '-linkedin-activate')
PYEOF
for i in 1 2; do
  echo "== post-activation probe $i"
  HOME=/home/ubuntu/workspace/macf/engine-home timeout 60 node /tmp/probe.js linkedin 50000 2>/dev/null
done
echo "DONE. Record the result as a comment on Vikunja #911."
