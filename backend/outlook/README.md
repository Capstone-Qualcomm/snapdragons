# Outlook backend

Microsoft identity platform OAuth server and Microsoft Graph reader. Outlook is connected as the signed-in user and this version only reads unread messages in the Inbox.

- `outlook-auth.ts` — authorization code flow with PKCE, refresh tokens, profile lookup, and reset
- `outlook-api.ts` — unread Inbox messages from Microsoft Graph, reduced to the fields Today needs
- `server.ts` — connection, message, activity, enable/disable, disconnect, and OAuth routes

## Microsoft Entra app setup

1. Register an app in Microsoft Entra ID. Choose the account types the integration should support. `OUTLOOK_TENANT_ID=common` supports organizational and personal Microsoft accounts when the registration allows both; set it to a tenant ID to restrict sign-in to one organization.
2. Add a **Web** redirect URI matching `OUTLOOK_REDIRECT_URI`, for example `http://localhost:3005/auth/outlook/callback`.
3. Create a client secret and set `OUTLOOK_CLIENT_ID` and `OUTLOOK_CLIENT_SECRET` in `backend/.env`.
4. Under Microsoft Graph **Delegated permissions**, add `Mail.ReadWrite`, `Mail.Send`, and `User.Read`. The app requests `openid profile email offline_access User.Read Mail.ReadWrite Mail.Send`. `Mail.ReadWrite` lets the signed-in user mark messages as read and delete them. `Mail.Send` allows a user to send a direct reply from Today.
5. Set `OUTLOOK_TENANT_ID`, `OUTLOOK_PORT`, and `OUTLOOK_REDIRECT_URI` in `backend/.env`. The local defaults are in `backend/.env.example`.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/outlook/connection` | Current connection status |
| GET | `/api/outlook/messages` | Unread Inbox messages |
| GET | `/api/outlook/messages/{id}/thread` | Load the messages and text content in a conversation |
| GET | `/api/outlook/activity` | Recent message sync activity |
| POST | `/api/outlook/messages/{id}/delete` | Delete a message |
| POST | `/api/outlook/messages/{id}/reply` | Send a direct reply and mark the original message as read |
| GET | `/auth/outlook/start` | Start OAuth flow |
| GET | `/auth/outlook/callback` | OAuth callback |
| POST | `/api/outlook/connection/enabled` | Toggle on/off |
| POST | `/api/outlook/connection/disconnect` | Remove saved token |

The backend calls `GET /v1.0/me/mailFolders/inbox/messages` for unread messages received in the past 72 hours, requests only message summary fields, and follows Microsoft Graph paging links. Opening Reply loads the full conversation on demand, including each message's unique text content. Delete applies only to the selected message. Reply uses Microsoft Graph's `POST /v1.0/me/messages/{id}/reply`, sends immediately, saves the reply in Sent Items, and then marks the original message as read.
