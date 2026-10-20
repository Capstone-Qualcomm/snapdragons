#!/usr/bin/env bash
set -euo pipefail

# Kill one node from ./scripts/start-cluster.sh mid-step, the way a board losing power would.
# SIGKILL gives it no chance to clean up or say goodbye. If it was the orchestrator
# the others elect a new one; either way its step moves to another node once its lease runs out.
# Usage: ./scripts/kill-worker.sh Q-02

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <worker name, e.g. Q-02>" >&2
  exit 1
fi

if pkill -9 -f "node.ts $1\$"; then
  echo "Killed $1. Its step goes to another node once its lease runs out (2 seconds by default)."
else
  echo "No running node named $1." >&2
  exit 1
fi
