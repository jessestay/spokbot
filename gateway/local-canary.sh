#!/bin/bash
# local-canary.sh -- MACF local-tier canary.
# Probes macf-cheap and macf-local through the gateway and appends one line
# per group to canary.log: "<ISO-8601 UTC> <group> <OK|FAIL> <latency>s".
# Installed 2026-10-22 with the desk-first local-tier restructure.
set -u
# Paths resolve relative to this script's own directory (US-FW-002:
# no hardcoded operator tree).
GATEWAY_DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$GATEWAY_DIR/gateway.env"
LOG="$GATEWAY_DIR/canary.log"
KEY=$(grep -E '^LITELLM_MASTER_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)
for GROUP in macf-cheap macf-local; do
  RESP_BODY=$(mktemp)
  OUT=$(curl -s -m 130 -o "$RESP_BODY" -w '%{http_code} %{time_total}' \
    http://127.0.0.1:4000/v1/chat/completions \
    -H "Authorization: Bearer $KEY" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$GROUP\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with the single word: ok\"}],\"max_tokens\":8}")
  CODE=$(echo "$OUT" | awk '{print $1}')
  LAT=$(echo "$OUT" | awk '{print $2}')
  if [ "$CODE" = "200" ] && grep -q '"content"' "$RESP_BODY"; then STATUS=OK; else STATUS=FAIL; fi
  echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $GROUP $STATUS ${LAT}s" >> "$LOG"
  rm -f "$RESP_BODY"
done
