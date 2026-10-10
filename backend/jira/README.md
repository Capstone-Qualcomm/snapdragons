# Jira OAuth backend

This server handles Atlassian's OAuth 2.0 authorization code flow. Keep the client secret and access/refresh tokens on the server; never put them in frontend code.

## Configure Atlassian

Create an OAuth 2.0 (3LO) integration in the Atlassian developer console. Add this callback URL to its authorization settings:

```text
http://localhost:3001/auth/jira/callback
```

Copy `.env.example` to `.env` and set `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`. The defaults request `read:jira-work`, `read:jira-user`, and `offline_access`. Add the same scopes to the integration's configuration. For a deployed app, set `APP_URL` to the frontend origin and `ATLASSIAN_REDIRECT_URI` to the public HTTPS callback URL registered in Atlassian.

## Run locally

```sh
cd backend/jira
npm start
```

Run the frontend separately with `cd frontend && npm run dev`. In Settings, Connect Jira redirects the browser to Atlassian for login and consent. After authorization, the server exchanges the code and lists the Jira sites available to that account.

This starter backend holds credentials and the connection in process memory for a single-user local setup. Restarting it clears the connection. Before multi-user or production use, persist encrypted tokens per authenticated app user and add refresh-token rotation and session protection.
