# Jira connection

The dashboard uses Atlassian OAuth 2.0 (3LO), so users connect Jira through Atlassian sign-in and consent. The app never asks for their Jira password or API token.

- `routes.mjs` handles OAuth start/callback, connection settings, and Jira issue routes.
- `oauth.mjs` calls Jira REST API v3 as the connected user.
- `connection-store.mjs` encrypts access and refresh tokens before writing the per-browser connection store.
- The Jira MCP adapter lives separately in `backend/mcp/jira/`.

## Create the Atlassian integration

1. In the [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/), create an OAuth 2.0 (3LO) integration.
2. Add the Jira Cloud platform API permission with the read scope `read:jira-work`.
3. Configure the callback URL to exactly match `JIRA_REDIRECT_URI`. For local frontend development, use `http://localhost:5173/auth/jira/callback`. For a hosted site, use its HTTPS URL, such as `https://app.example.com/auth/jira/callback`.
4. Enable sharing when you are ready for users outside the integration owner to authorize it. Atlassian may show an unapproved integration warning until its review process is complete.

The app requests `read:jira-work` and `offline_access`; the latter enables refresh tokens. Jira access is limited to the permissions of the user who connected it.

## Configure the server

Copy `backend/integrations/jira/.env.example` to `backend/integrations/jira/.env`. Fill in the Atlassian client ID, client secret, and exact callback URL. Generate two independent random values with Node, and put one in each secret setting:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Use one generated value for `APP_SESSION_SECRET` and another for `JIRA_TOKEN_ENCRYPTION_KEY`. The token key must be 64 hexadecimal characters. Keep `.env` and the persistent connection store private; neither belongs in Git.

## Run the local development app

From the repository root, start the backend:

```bash
node --env-file=backend/integrations/jira/.env backend/server.mjs
```

In another terminal, start the frontend:

```bash
cd frontend
npm run dev
```

Vite proxies `/api` and `/auth` to the backend. Open Settings and choose **Connect Jira**. Each browser profile has its own signed session and Jira connection; this version does not have a separate Continuum account or cross-device connection sync.

## Host the public app

Deploy the frontend and backend behind the same HTTPS origin. Route `/api/jira/*` and `/auth/jira/*` to `server.mjs`, and serve the Vite build for the remaining paths. Set `HOST=0.0.0.0` when the platform needs the backend to accept traffic from its proxy. Register the public HTTPS callback in Atlassian, set `NODE_ENV=production`, and provide the OAuth client secret, session secret, and token encryption key through the hosting provider's secret manager.

Mount persistent private storage for `JIRA_CONNECTION_STORE`. The current store is intended for a single backend instance; the OAuth state cache is in memory. Before running multiple instances, move connection and pending OAuth state storage to a shared database/cache with equivalent encryption and transaction guarantees. Back up the encryption key securely; connections cannot be read without it.
