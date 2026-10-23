#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
JIRA_DIR="$ROOT/backend/jira"
SLACK_DIR="$ROOT/backend/slack"
GITHUB_DIR="$ROOT/backend/github"
OUTLOOK_DIR="$ROOT/backend/outlook"
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
  kill "$JIRA_PID" "$SLACK_PID" "$GITHUB_PID" "$OUTLOOK_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$JIRA_PID" "$SLACK_PID" "$GITHUB_PID" "$OUTLOOK_PID" "$FRONTEND_PID" 2>/dev/null || true
}

(cd "$JIRA_DIR" && APP_URL="${APP_URL:-http://localhost:5173/snapdragons}" npm start) &
JIRA_PID=$!
(cd "$SLACK_DIR" && APP_URL="${APP_URL:-http://localhost:5173/snapdragons}" npm start) &
SLACK_PID=$!
(cd "$GITHUB_DIR" && APP_URL="${APP_URL:-http://localhost:5173/snapdragons}" npm start) &
GITHUB_PID=$!
(cd "$OUTLOOK_DIR" && APP_URL="${APP_URL:-http://localhost:5173/snapdragons}" npm start) &
OUTLOOK_PID=$!
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

trap stop_services INT TERM EXIT

echo "Jira, Slack, GitHub and Outlook backends plus Vite are starting. Open the URL printed by Vite (usually http://localhost:5173)."
echo "Jira listens on 3001, Slack on 3002, GitHub on 3004, Outlook on 3005, and Vite serves the app at /snapdragons/ and proxies their API and OAuth routes."
echo "For live nodes on Today and in the Cluster view, run ./scripts/start-cluster.sh in another terminal."
echo "Press Ctrl+C to stop everything."

wait "$JIRA_PID" "$SLACK_PID" "$GITHUB_PID" "$OUTLOOK_PID" "$FRONTEND_PID"
