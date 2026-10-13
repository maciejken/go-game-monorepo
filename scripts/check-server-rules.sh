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

DB_PATH="$WORK/flow.db"
export DB_PATH
# The checkers between them register a dozen accounts from one address,
# which is more than the real limit allows in an hour — and the suite has
# to survive being run twice in a row.
REGISTER_RATE_LIMIT=1000
export REGISTER_RATE_LIMIT
ADMIN_USERNAME=suiteadmin
export ADMIN_USERNAME
PORT="$PORT" npx tsx server/src/server.ts > "$WORK/server.log" 2>&1 &
SERVER_PID=$!

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:$PORT/api/auth/me"; then break; fi
  sleep 0.25
done

node scripts/check-db-migration.mjs
node scripts/check-server-flow.mjs "http://localhost:$PORT"
node scripts/check-server-import.mjs "http://localhost:$PORT"
node scripts/check-server-account.mjs "http://localhost:$PORT"
node scripts/check-server-blocks.mjs "http://localhost:$PORT"
node scripts/check-server-stars.mjs "http://localhost:$PORT"
node scripts/check-server-progress.mjs "http://localhost:$PORT"
node scripts/check-server-reports.mjs "http://localhost:$PORT" "$ADMIN_USERNAME"
# Takes the database file too: pruning stored boards is what it checks.
node scripts/check-server-replay.mjs "http://localhost:$PORT" "$DB_PATH"
