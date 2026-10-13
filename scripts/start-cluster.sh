#!/usr/bin/env bash
set -euo pipefail

# Fake cluster on one laptop: one queue server and three worker processes.
# Usage: ./scripts/start-cluster.sh [number of tasks to queue, default 9]

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER_DIR="$ROOT/backend/cluster"
export CLUSTER_PORT="${CLUSTER_PORT:-3003}"
URL="http://localhost:$CLUSTER_PORT"
TASKS="${1:-9}"
PIDS=()

stop_cluster() {
  trap - INT TERM EXIT
  kill "${PIDS[@]}" 2>/dev/null || true
  wait "${PIDS[@]}" 2>/dev/null || true
}
trap stop_cluster INT TERM EXIT

cd "$CLUSTER_DIR"
node server.ts &
PIDS+=($!)

until curl -sf "$URL/api/cluster/state" >/dev/null; do sleep 0.2; done

for id in Q-01 Q-02 Q-03; do
  WORKER_ID="$id" node worker.ts &
  PIDS+=($!)
done

for n in $(seq 1 "$TASKS"); do
  curl -sf -X POST "$URL/api/cluster/tasks" -d "{\"input\":\"task $n\"}" >/dev/null
done
echo "Queued $TASKS tasks for Q-01, Q-02 and Q-03. State: $URL/api/cluster/state"

until curl -sf "$URL/api/cluster/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.exit(JSON.parse(s).tasks.every(t=>t.status==="done")?0:1))'; do sleep 0.5; done

echo
curl -sf "$URL/api/cluster/state" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const w of JSON.parse(s).workers)console.log(`${w.id} finished ${w.done} tasks`)})'
echo "All tasks done. The cluster is still running, so you can queue more. Press Ctrl+C to stop it."

wait
