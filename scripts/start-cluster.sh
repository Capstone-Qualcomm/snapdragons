#!/usr/bin/env bash
set -euo pipefail

# The cluster on one laptop: the gateway on port 3003 and three node processes,
# each a Raft peer plus a worker, with auto refresh on. Open the Console page to watch it.
# Usage: ./scripts/start-cluster.sh [number of nodes, default 3]

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
export CLUSTER_PORT="${CLUSTER_PORT:-3003}"
export CLUSTER_NODES="${1:-3}"
export CLUSTER_AUTO="${CLUSTER_AUTO:-1}"

cd "$ROOT/backend/cluster"
# exec, so Ctrl+C reaches the gateway and it takes the nodes down with it.
exec node server.ts
