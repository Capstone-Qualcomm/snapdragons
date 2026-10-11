# Jira OAuth backend

This server handles Atlassian's OAuth 2.0 authorization code flow. Keep the client secret and access/refresh tokens on the server; never put them in frontend code.

## Configure Atlassian

Create an OAuth 2.0 (3LO) integration in the Atlassian developer console. Add this callback URL to its authorization settings:

```text
http://localhost:3001/auth/jira/callback
```

Copy `backend/.env.example` to `backend/.env` from the repository root, then set `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET`. This shared backend environment file sits alongside the Jira, Outlook, and Slack integration folders. The Jira server loads it when started from `backend/jira`. The app requests `read:jira-work`, `read:jira-user`, `write:jira-work`, and `offline_access`. Add the corresponding scopes to the integration's configuration. For a deployed app, set `APP_URL` to the frontend origin and `ATLASSIAN_REDIRECT_URI` to the public HTTPS callback URL registered in Atlassian.

## Run locally

The Jira backend uses native TypeScript support in Node.js 22.18 or newer. TypeScript is type-checked separately with the `typecheck` script.

```sh
cd backend/jira
npm start
```

Run `npm run typecheck` in `backend/jira` to check the backend and its tests. `bash tests/local_tests.sh` runs the backend tests.

Run the frontend separately with `cd frontend && npm run dev`. In Settings, Connect Jira redirects the browser to Atlassian for login and consent. After authorization, the server exchanges the code and lists the Jira sites available to that account.

The report requests `GET /api/jira/issues`. The backend searches Jira for unfinished issues assigned to the connected account and returns row data plus expandable metadata: description, sprint, labels, story point estimate, and reporter. Sprint and story point custom fields are discovered from the Jira field catalog because their IDs vary between sites. `GET /api/jira/issues/:key/transitions` lists available status changes, and `POST /api/jira/issues/:key` updates description, story point estimate, and workflow status. It uses Jira Cloud's enhanced JQL search endpoint and refreshes expiring access tokens using Atlassian's rotating refresh-token flow.

This starter backend holds credentials and the connection in process memory for a single-user local setup. Restarting it clears the connection. Before multi-user or production use, persist encrypted tokens per authenticated app user and add app-user session protection.
