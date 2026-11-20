#!/usr/bin/env bash
# Server supervision liveness check: are the MACF services actually alive
# and is the engine actually working (not just breathing)?
# Prints one summary line per run; posts to Slack #management only on a
# state transition (something went down / everything recovered).
set -u
SUP=/home/ubuntu/workspace/macf/supervision
STATE="$SUP/state/liveness.json"
mkdir -p "$SUP/state"
FAIL=""

for svc in macf-engine macf-vikunja macf-gateway macf-n8n; do
  systemctl is-active --quiet "$svc" || FAIL="$FAIL $svc:inactive"
done

VIK=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:3456/api/v1/info 2>/dev/null || echo 000)
[ "$VIK" = "200" ] || FAIL="$FAIL vikunja-api:http=$VIK"

# LiteLLM /health does deep downstream checks and 500s when a model leg is
# down; /health/liveliness is the process-liveness probe.
GW=$(curl -s -o /dev/null -w '%{http_code}' -m 10 http://127.0.0.1:4000/health/liveliness 2>/dev/null || echo 000)
[ "$GW" = "200" ] || FAIL="$FAIL gateway:http=$GW"

# Engine execution liveness: the standalone log must have been written
# recently (scan task runs complete about every minute when healthy).
LOG=/home/ubuntu/workspace/macf/engine-standalone.log
NOW=$(date +%s)
if [ -f "$LOG" ]; then
  MTIME=$(stat -c %Y "$LOG")
  AGE=$(( NOW - MTIME ))
  [ "$AGE" -lt 600 ] || FAIL="$FAIL engine-log:stale-${AGE}s"
else
  FAIL="$FAIL engine-log:missing"
fi

PREV="ok"
[ -f "$STATE" ] && PREV=$(python3 -c "import json;print(json.load(open('$STATE')).get('status','ok'))" 2>/dev/null || echo ok)

if [ -z "$FAIL" ]; then
  CUR="ok"
  echo "liveness OK: services active, vikunja api 200, gateway 200, engine log fresh"
else
  CUR="down"
  echo "liveness DOWN:$FAIL"
fi
printf '{"status": "%s", "fail": "%s", "at": %s}\n' "$CUR" "$(echo $FAIL)" "$NOW" > "$STATE.tmp" && mv "$STATE.tmp" "$STATE"

if [ "$CUR" != "$PREV" ]; then
  if [ "$CUR" = "down" ]; then
    MSG=":rotating_light: *MACF server liveness alert* — checks failing:$FAIL (Oracle macf-server). The CEO heartbeat will keep flagging this until it recovers."
  else
    MSG=":white_check_mark: *MACF server liveness recovered* — all services active, Vikunja API and gateway responding, engine log fresh."
  fi
  python3 - "$MSG" <<'PYEOF'
import sys
sys.path.insert(0, "/home/ubuntu/workspace/macf/supervision/checks")
from slack_alert import post
try:
    post(sys.argv[1])
    print("transition alert posted")
except Exception as e:
    print("alert post failed: %s" % e)
PYEOF
fi

[ "$CUR" = "ok" ]
