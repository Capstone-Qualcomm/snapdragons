#!/usr/bin/env bash
set -euo pipefail

# Kill one worker from ./scripts/start-cluster.sh mid-task, the way a board losing power would.
# SIGKILL gives it no chance to clean up or report back, so the queue only finds
# out when the heartbeats stop and the lease runs out.
# Usage: ./scripts/kill-worker.sh Q-02

if [[ $# -ne 1 ]]; then
  echo "Usage: $0 <worker name, e.g. Q-02>" >&2
  exit 1
fi

if pkill -9 -f "worker.ts $1\$"; then
  echo "Killed $1. Its task goes to another worker once the lease runs out (2 seconds by default)."
else
  echo "No running worker named $1." >&2
  exit 1
fi
