# Jira OAuth backend

This backend connects to Jira Cloud using Atlassian OAuth 2.0 (3LO). The client secret and OAuth tokens stay in the backend; never put them in frontend code or commit `backend/.env`.

## 1. Create an Atlassian OAuth app

1. Sign in to [Atlassian Developer Console](https://developer.atlassian.com/console/myapps/).
2. Choose **Create** → **OAuth 2.0 integration**. Give the integration a name and create it.
3. Open the new app's **Permissions** page. Add the **Jira platform REST API**, then choose **Configure**.
4. Add these scopes (the app uses all four):

   - `read:jira-work` — read assigned issues and their fields.
   - `read:jira-user` — read Jira user information such as reporter names.
   - `write:jira-work` — update issue descriptions, story points, and status.
   - `offline_access` — receive refresh tokens so the connection can renew access without asking you to log in each time.

   Save the permission changes. Existing grants may need to be renewed after scopes change; reconnect Jira from the Jira menu in Today.

5. Open **Authorization**. Configure **OAuth 2.0 (3LO)** and add this callback URL exactly:

   ```text
   http://localhost:3001/auth/jira/callback
   ```

   Save the changes. The callback must match `ATLASSIAN_REDIRECT_URI` exactly, including scheme, host, port, path, and trailing slash (there is no trailing slash here).

6. Open **Settings** in the Developer Console app. Copy the **Client ID** and **Secret** from the authentication details. These are the values for `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` below. They are app credentials, not your Jira site URL, Atlassian account email, or Jira API token. Keep the secret private. If Atlassian only offers a newly generated secret, replace the old value in `.env` with it.

Atlassian's [OAuth 2.0 (3LO) guide](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) documents creating the integration and configuring Authorization, Permissions, and Settings.

## 2. Create and fill in `backend/.env`

The shared environment file is `backend/.env` at the repository root, alongside the `jira`, `outlook`, and `slack` folders. The Jira start script loads it automatically. From the repository root, create it from the checked-in template if it does not already exist:

```sh
cp backend/.env.example backend/.env
```

Open `backend/.env` and set the values as follows:

| Variable | Local development value | How to determine it |
| --- | --- | --- |
| `PORT` | `3001` | Backend listen port. Keep this at `3001` unless you also update the callback URL. |
| `APP_URL` | `http://localhost:5173` | Frontend origin. The local Vite frontend runs at this address. Do not include a path such as `/settings`. |
| `ATLASSIAN_CLIENT_ID` | *(your app's Client ID)* | Atlassian Developer Console → your OAuth app → **Settings** → copy **Client ID**. |
| `ATLASSIAN_CLIENT_SECRET` | *(your app's Secret)* | Same **Settings** page → copy **Secret**. Store it only in this backend env file. |
| `ATLASSIAN_REDIRECT_URI` | `http://localhost:3001/auth/jira/callback` | Must be identical to the callback URL saved under the app's **Authorization** settings. |
| `ATLASSIAN_SCOPES` | `read:jira-work read:jira-user write:jira-work offline_access` | Space-separated list of the scopes added under **Permissions**. Keep the names exact. |

The repository's `backend/.env.example` already contains the local values for all entries other than the client ID and secret. Replace the two placeholders and save the file. Do not add quotes around values or put commas between scopes.

For a deployed setup, set `APP_URL` to the frontend's public origin and `ATLASSIAN_REDIRECT_URI` to the backend's public HTTPS callback URL. Register that same HTTPS callback in the Atlassian app's **Authorization** settings. Keep `PORT` aligned with the backend hosting configuration. Never use the local callback URL for a deployed backend.

## 3. Start the app

From the repository root, run:

```sh
./scripts/start-dev.sh
```

Open the frontend URL printed by Vite (usually `http://localhost:5173`), then choose **Connect Jira** in Today. Sign in to Atlassian and grant access. Press **Ctrl+C** in the terminal to stop the backend and frontend.
