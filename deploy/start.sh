#!/bin/bash
# The live site's processes: the source backends, the simulated cluster and Caddy in front.
cd /app/backend
APP_URL="${APP_URL:-https://qualcomm.sanyamgarg.com/snapdragons}"
TEAMS_REDIRECT_URI="${TEAMS_REDIRECT_URI:-${APP_URL%/}/auth/teams/callback}"
NOTION_REDIRECT_URI="${NOTION_REDIRECT_URI:-${APP_URL%/}/auth/notion/callback}"
export APP_URL TEAMS_REDIRECT_URI NOTION_REDIRECT_URI
PORT=3001 node jira/server.ts &
SLACK_PORT=3002 node slack/server.ts &
GITHUB_PORT=3004 node github/server.ts &
OUTLOOK_PORT=3005 node outlook/server.ts &
TEAMS_PORT=3006 node teams/server.ts &
NOTION_PORT=3007 node notion/server.ts &
# The gateway starts the boards itself (ports 4101+) and keeps their logs in /tmp.
CLUSTER_PORT=3003 CLUSTER_NODES=5 CLUSTER_AUTO=1 node cluster/server.ts &
caddy run --config /app/deploy/Caddyfile --adapter caddyfile &
# If any process dies, exit so Docker restarts the whole thing.
wait -n
exit 1
