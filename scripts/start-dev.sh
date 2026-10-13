#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
JIRA_DIR="$ROOT/backend/jira"
SLACK_DIR="$ROOT/backend/slack"
FRONTEND_DIR="$ROOT/frontend"

if [[ ! -f "$ROOT/backend/.env" ]]; then
  echo "Missing backend/.env. Copy backend/.env.example to backend/.env and add the integration credentials first." >&2
  exit 1
fi

if [[ ! -d "$FRONTEND_DIR/node_modules" ]]; then
  echo "Frontend dependencies are not installed. Run 'npm install' in frontend first." >&2
  exit 1
fi

stop_services() {
  trap - INT TERM EXIT
  kill "$JIRA_PID" "$SLACK_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$JIRA_PID" "$SLACK_PID" "$FRONTEND_PID" 2>/dev/null || true
}

(cd "$JIRA_DIR" && npm start) &
JIRA_PID=$!
(cd "$SLACK_DIR" && npm start) &
SLACK_PID=$!
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

trap stop_services INT TERM EXIT

echo "Jira backend, Slack backend and Vite frontend are starting. Open the URL printed by Vite (usually http://localhost:5173)."
echo "Jira listens on 3001, Slack on 3002, Vite proxies /api/slack* and /auth/slack* to 3002."
echo "For live nodes on the Console page, run ./scripts/start-cluster.sh in another terminal."
echo "Press Ctrl+C to stop everything."

wait "$JIRA_PID" "$SLACK_PID" "$FRONTEND_PID"