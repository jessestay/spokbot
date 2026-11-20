#!/usr/bin/env bash
# MACF server supervision runner.
# usage: run.sh <name> <cmd...>
# Runs cmd from the server slack-agents tree with the engine's HOME,
# appends timestamped output to supervision/logs/<name>.log and writes
# supervision/state/<name>.stamp ("<epoch> <exit_code>") on every run.
set -u
NAME="$1"; shift
SUP=/home/ubuntu/workspace/macf/supervision
SA=/home/ubuntu/workspace/macf/slack-agents
mkdir -p "$SUP/logs" "$SUP/state"
LOG="$SUP/logs/$NAME.log"
STAMP="$SUP/state/$NAME.stamp"
{
  echo "===== $(date -u +%FT%TZ) START $NAME: $*"
  cd "$SA" && HOME=/home/ubuntu/workspace/macf/engine-home "$@"
  RC=$?
  echo "===== $(date -u +%FT%TZ) END $NAME rc=$RC"
  printf '%s %s\n' "$(date +%s)" "$RC" > "$STAMP.tmp" && mv "$STAMP.tmp" "$STAMP"
  exit $RC
} >> "$LOG" 2>&1
