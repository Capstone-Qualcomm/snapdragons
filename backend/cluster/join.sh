#!/bin/sh
# Joins this Uno Q board to the Continuum cluster. Run it once on the board:
#   curl -fsSL __APP_URL__/api/cluster/join.sh | sh -s -- <your name> <tailnet auth key>
# It needs only Docker, which App Lab already runs. Everything lives in ~/continuum: the board's own
# tailnet container (the boards' private network, apart from anything else on the board) and the
# node, which shares that container's network. Run it again to update the code; the log is kept.
set -eu

NAME=$(printf '%s' "${1:-}" | tr 'A-Z' 'a-z' | tr -cd 'a-z0-9-')
KEY=${2:-}
if [ -z "$NAME" ] || [ -z "$KEY" ]; then
  echo "Usage: curl -fsSL __APP_URL__/api/cluster/join.sh | sh -s -- <your name> <tailnet auth key>" >&2
  exit 1
fi
ID="q-$NAME"
APP="__APP_URL__"
DIR="$HOME/continuum"

DOCKER=docker
docker info >/dev/null 2>&1 || DOCKER="sudo docker"

mkdir -p "$DIR/code"
cd "$DIR"
echo "Downloading the node's code..."
curl -fsSL "$APP/api/cluster/code.tgz" | tar -xz -C code
(umask 077 && printf 'TS_AUTHKEY=%s\n' "$KEY" > ts.env)

cat > compose.yaml <<EOF
services:
  ts:
    image: tailscale/tailscale:stable
    hostname: $ID
    restart: unless-stopped
    env_file: ts.env
    environment:
      TS_STATE_DIR: /var/lib/tailscale
      TS_USERSPACE: "false"
      TS_ACCEPT_DNS: "true"
      TS_EXTRA_ARGS: --advertise-tags=tag:board
    volumes: [ts-state:/var/lib/tailscale]
    devices: [/dev/net/tun:/dev/net/tun]
    cap_add: [NET_ADMIN, NET_RAW]

  node:
    image: node:24-slim
    working_dir: /code
    command: node node.ts
    restart: unless-stopped
    network_mode: service:ts
    depends_on: [ts]
    environment:
      NODE_ID: $ID
      NODE_PORT: "4101"
      NODE_HOST: 0.0.0.0
      CLUSTER_DATA: /data
      CLUSTER_JOIN_URL: $APP/api/cluster/join
      SERVICES_URL: http://q-orsat:4100
      # Boards talk through Tailscale relays (150 to 350 ms a round trip, and slow for anything big),
      # so Raft gets room: a message may take 30 s, since a board that fell behind is sent the whole
      # queue at once (one message at a time per board, so they never pile up); an orchestrator is
      # presumed dead after 4 to 8 s of silence; a board's step moves to another after 6 s without a heartbeat.
      RAFT_SEND_TIMEOUT_MS: "30000"
      RAFT_HEARTBEAT_MS: "500"
      RAFT_ELECTION_MIN_MS: "4000"
      RAFT_ELECTION_MAX_MS: "8000"
      LEASE_MS: "6000"
    volumes: [./code:/code:ro, node-data:/data]

volumes:
  ts-state:
  node-data:
EOF

echo "Starting $ID..."
$DOCKER compose up -d --force-recreate
echo "Done. $ID shows up on $APP/cluster within a minute."
echo "Logs: cd $DIR && $DOCKER compose logs -f node"
