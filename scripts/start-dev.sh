#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
BACKEND_DIR="$ROOT/backend/jira"
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
  kill "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
  wait "$BACKEND_PID" "$FRONTEND_PID" 2>/dev/null || true
}

(cd "$BACKEND_DIR" && npm start) &
BACKEND_PID=$!
(cd "$FRONTEND_DIR" && npm run dev) &
FRONTEND_PID=$!

trap stop_services INT TERM EXIT

echo "Jira backend and Vite frontend are starting. Open the URL printed by Vite (usually http://localhost:5173)."
echo "Press Ctrl+C to stop both."

wait "$BACKEND_PID" "$FRONTEND_PID"
