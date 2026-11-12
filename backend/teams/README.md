# Microsoft Teams connection

The Teams source uses delegated Microsoft Graph access to show recent direct chat messages that need a response and recent group chat messages that mention the signed-in user. It is read-only in this version and supports Microsoft work or school accounts with Teams; Graph chat APIs do not support personal Microsoft accounts.

## Register the Microsoft Entra app

1. In Microsoft Entra admin center, register a web application for the accounts the project should support. If you already set up Outlook, you can add Teams to that same Entra app.
2. Add this Web redirect URI for local development: `http://localhost:3006/auth/teams/callback`.
3. Create a client secret if needed and copy the application's Client ID and secret into the `TEAMS_CLIENT_ID` and `TEAMS_CLIENT_SECRET` settings. These can match the Outlook credentials.
4. Under API permissions, add Microsoft Graph **delegated** permission `Chat.Read` (and `User.Read` if it is not already present). The app requests `openid profile email offline_access User.Read Chat.Read` so sign-in can be renewed.
5. If the tenant requires administrator consent, have an administrator grant consent to the delegated Teams chat permission.

## Configure and connect

Add these values to `backend/.env` (the checked-in `.env.example` has local defaults):

```env
TEAMS_PORT=3006
TEAMS_TENANT_ID=common
TEAMS_CLIENT_ID=your-microsoft-application-client-id
TEAMS_CLIENT_SECRET=your-microsoft-application-client-secret
TEAMS_REDIRECT_URI=http://localhost:3006/auth/teams/callback
TEAMS_SCOPES=openid profile email offline_access User.Read Chat.Read
```

Keep the client secret in the backend environment file. For a deployed app, register the public HTTPS callback URL and set the matching `TEAMS_REDIRECT_URI`, `APP_URL`, and tenant ID. Start the project with `scripts/start-dev.sh`, then choose **Connect Teams** on the Connections page.

The connector checks up to 40 recent one-to-one and group chats, showing incoming direct messages and group messages that mention the signed-in user from the past seven days. The Teams backend listens on port 3006.
