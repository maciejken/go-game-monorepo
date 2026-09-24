#!/bin/bash
# Boots a server on a scratch database, drives the game-flow fixtures
# through its real API, and shuts it down again. Never touches a database
# you care about: the file lives in a temp directory and goes with it.
set -e
cd "$(dirname "$0")/.."
WORK=$(mktemp -d)
PORT=${FLOW_PORT:-3010}
cleanup() {
  [ -n "$SERVER_PID" ] && kill "$SERVER_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

DB_PATH="$WORK/flow.db" PORT="$PORT" npx tsx server/src/server.ts > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/auth/me"; then break; fi
  sleep 0.25
done

node scripts/check-server-flow.mjs "http://localhost:$PORT"
node scripts/check-server-import.mjs "http://localhost:$PORT"
