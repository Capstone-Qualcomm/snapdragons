# Notion backend

OAuth connection and read-only page search for Ask Notion. The integration can search page titles and read the contents of pages the user shares with it; it never creates or edits pages.

## Setup

1. Create a Notion public integration with read content capability and enable OAuth.
2. Register a local callback URI such as `http://localhost:3007/auth/notion/callback` and the deployed callback URL for the app.
3. Set `NOTION_CLIENT_ID`, `NOTION_CLIENT_SECRET`, `NOTION_REDIRECT_URI`, and `NOTION_PORT` in `backend/.env`.
4. Start the app, open Connections, connect Notion, and choose the pages the integration may access.

The OAuth token is stored in the per-browser server session. The cluster gateway forwards the browser's session cookie to this backend when an Ask Notion job starts. Page text and source URLs are passed into the Raft job so workers can summarize them; the OAuth token is not sent to the cluster.

## Routes

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/notion/connection` | Connection status |
| POST | `/api/notion/connection/enabled` | Turn Notion search on or off |
| POST | `/api/notion/connection/disconnect` | Remove the saved token |
| POST | `/api/notion/search` | Search page titles and read matching page text; called by the cluster gateway |
| GET | `/auth/notion/start` | Start OAuth |
| GET | `/auth/notion/callback` | Complete OAuth |
