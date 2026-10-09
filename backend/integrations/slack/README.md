# Slack connection

Users connect Slack from Settings with Slack's OAuth consent screen, the same way Jira works. The app asks for a user token, so it only sees what the person who connected can see.

- `slack.mjs` handles OAuth, calls the Slack Web API, and turns messages into report items.
- `routes.mjs` serves `/auth/slack/*` and `/api/slack/*`.
- Tokens are encrypted with `core/connection-store.mjs`, shared with Jira.

## What shows up in Report

- **Needs a reply:** DMs where the newest message is from the other person and arrived in the last 24 hours.
- **Mentions:** messages from the last 24 hours that @mention you, found with `search.messages`.

Each item has `id`, `kind` (`dm` or `mention`), `from`, `where`, `text`, `sentAt` (ISO) and `url` (permalink).

## Create the Slack app

1. At https://api.slack.com/apps, create an app from scratch in the Qualcomm Team 1 workspace.
2. Under OAuth & Permissions, add the user token scopes `search:read`, `im:read`, `im:history` and `users:read`.
3. Add the redirect URL that matches `SLACK_REDIRECT_URI`. Slack only accepts HTTPS, so for local development use an HTTPS tunnel (for example `cloudflared tunnel --url http://localhost:5173`) and register `https://<tunnel-host>/auth/slack/callback`.
4. Copy `.env.example` to `.env` and fill in the client ID, client secret, redirect URL and a new encryption key.

## Run

```bash
node --env-file=backend/integrations/jira/.env --env-file=backend/integrations/slack/.env backend/server.mjs
```

Tests: `node --test tests/integration/slack.test.mjs`
