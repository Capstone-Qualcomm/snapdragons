# GitHub source setup

The GitHub backend connects one signed-in GitHub user to Today. It reads that user's assigned open issues and pull requests. It does not modify GitHub items and does not use webhooks.

## Create the GitHub App

1. In GitHub, open **Settings → Developer settings → GitHub Apps → New GitHub App** (or create it under the organization that should own the app).
2. Give it a recognizable name, such as `SnapDragons Capstone`, and set a homepage URL such as `http://localhost:5173` for local development.
3. Under **Identifying and authorizing users**, add this Redirect URI exactly:

   `http://localhost:3004/auth/github/callback`

   Leave wildcard matching off. Enable expiring user authorization tokens so GitHub provides refresh tokens. The app uses the web authorization flow started from the app's Connect GitHub button; device flow and post-install setup are not needed.
4. Grant read-only access to the **Issues** and **Pull requests** repository permissions. No webhook URL or event subscriptions are required.
5. Create the app, copy its Client ID, and generate a Client Secret. Keep the secret private. When GitHub asks where to install the app, install it on the account/repositories whose work you want to retrieve.

## Configure the local project

Copy `backend/.env.example` to `backend/.env` if needed. Set these values in `backend/.env`:

```env
GITHUB_PORT=3004
GITHUB_CLIENT_ID=your-client-id
GITHUB_CLIENT_SECRET=your-client-secret
GITHUB_REDIRECT_URI=http://localhost:3004/auth/github/callback
```

Never put real credentials in `.env.example`, frontend code, or a commit. The local GitHub service binds to `127.0.0.1` and accepts connection-changing requests only from the configured frontend origin.

Start the project using `scripts/start-dev.sh`, open the frontend, and choose **Connect GitHub**. After authorizing the app, assigned open issues and pull requests appear in Today. Use **Refresh** to load them again.

## Verify the GitHub backend

From `backend/github`, run:

```sh
npm test
npm run typecheck
```
