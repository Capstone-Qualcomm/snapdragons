# Slack backend

OAuth server for the Slack integration. Connects a user's Slack workspace so the report can show unanswered DMs and mentions from the last 24 hours.

- `slack-auth.ts` — OAuth 2.0 flow (start, callback, token exchange, reset)
- `slack-api.ts` — message fetching (mentions via `search.messages`, unanswered DMs via `conversations.history`), text cleanup
- `slack-logs.ts` — in-memory request log for the Console > Logs page
- `server.ts` — HTTP server wiring all Slack routes

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/slack/connection` | Current connection status |
| GET | `/api/slack/messages` | Mentions and unanswered DMs |
| GET | `/auth/slack/start` | Start OAuth flow |
| GET | `/auth/slack/callback` | OAuth callback |
| POST | `/api/slack/connection/enabled` | Toggle on/off |
| POST | `/api/slack/connection/disconnect` | Remove token |

## Scopes

User scopes: `search:read`, `im:read`, `im:history`, `users:read`

The app reads messages as the user who authorizes it; no bot token or workspace-wide access.