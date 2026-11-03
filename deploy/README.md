# Deploy

The live site runs on orsat from `/opt/stacks/snapdragons`. A cron job checks GitHub main every minute and rebuilds when it changes, so merging to main deploys.

The container runs `deploy/start.sh`, and Caddy routes with `deploy/Caddyfile`. Both come from the commit being deployed, so a new API route goes live with the code that needs it. When the frontend calls a new `/api/<name>` path, add it to `deploy/Caddyfile` (and to the proxy in `frontend/vite.config.js` if Jira, its catch-all, should not get it); `tests/deploy.test.ts` fails while the Caddyfile is missing it.

https://qualcomm.sanyamgarg.com/demo/ is the demo page we send our mentor. Its files (`index.html`, `demo.mp4`, `poster.jpg`) live on orsat in `/opt/stacks/snapdragons/demo`, mounted into the container at `/srv/demo`, so the video stays out of git. To update it, copy new files there; no deploy needed.
