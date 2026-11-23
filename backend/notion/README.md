# Notion OAuth backend

This service connects each browser to a Notion workspace using Notion OAuth. Client credentials and OAuth tokens stay in the backend; never put them in frontend code or commit `backend/.env`.

## Create a Notion OAuth integration

1. Create an OAuth integration in the [Notion developer portal](https://www.notion.so/profile/integrations).
2. In its OAuth configuration, register this local redirect URI exactly:

   ```text
   http://localhost:3007/auth/notion/callback
   ```

   For the deployed app, register `https://qualcomm.sanyamgarg.com/snapdragons/auth/notion/callback` and set `NOTION_REDIRECT_URI` to that same value.
3. Copy the integration's OAuth client ID and client secret into `NOTION_CLIENT_ID` and `NOTION_CLIENT_SECRET` in `backend/.env`. Keep the secret private.
4. Copy `backend/.env.example` to `backend/.env` if needed, then start the app with `./scripts/start-dev.sh` and open `/auth/notion/start` under the app base path to authorize.

Notion asks the user to choose which pages to share with the integration. The OAuth callback stores the access and refresh tokens, workspace details, and owner details in the per-browser `notion-sessions.json` file under `DATA_DIR`. The token exchange and future API calls belong on the server.

The first sync searches shared page titles and returns each page's title, last edit time, and URL. It does not load page contents. Search results may not be a complete inventory and can take time to reflect newly shared pages; refresh the report after sharing pages.

See [Notion's authorization guide](https://developers.notion.com/guides/authorization/overview) for OAuth setup and token handling details.
The sync uses [Notion's Search API](https://developers.notion.com/reference/post-search), with pagination and the `2026-03-11` API version.
