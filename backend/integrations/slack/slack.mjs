import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnectionStore } from "../../core/connection-store.mjs";

const defaultStore = resolve(dirname(fileURLToPath(import.meta.url)), ".data/slack-connections.json");
export const store = createConnectionStore(process.env.SLACK_CONNECTION_STORE ?? defaultStore, "SLACK_TOKEN_ENCRYPTION_KEY");

// User scopes, so the app reads Slack as the person who connected it.
const userScopes = "search:read,im:read,im:history,users:read";
const lookback = 24 * 60 * 60;

export function slackOAuthConfigured() {
  const sessionReady = Buffer.byteLength(process.env.APP_SESSION_SECRET ?? "") >= 32;
  const encryptionReady = /^[a-f\d]{64}$/i.test(process.env.SLACK_TOKEN_ENCRYPTION_KEY ?? "");
  return Boolean(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET && process.env.SLACK_REDIRECT_URI && sessionReady && encryptionReady);
}

export function authorizationUrl(state) {
  if (!slackOAuthConfigured()) throw new Error("Slack OAuth is not configured on this server.");
  const url = new URL("https://slack.com/oauth/v2/authorize");
  url.searchParams.set("client_id", process.env.SLACK_CLIENT_ID);
  url.searchParams.set("user_scope", userScopes);
  url.searchParams.set("redirect_uri", process.env.SLACK_REDIRECT_URI);
  url.searchParams.set("state", state);
  return url;
}

async function slackApi(token, method, params = {}) {
  const url = new URL(`https://slack.com/api/${method}`);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const result = await response.json();
  if (!result.ok) {
    if (result.error === "invalid_auth" || result.error === "token_revoked") throw new Error("Slack authorization expired. Reconnect Slack in Settings.");
    throw new Error(`Slack returned ${result.error} while loading messages.`);
  }
  return result;
}

export async function completeAuthorization(sessionId, code) {
  const response = await fetch("https://slack.com/api/oauth.v2.access", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: process.env.SLACK_CLIENT_ID,
      client_secret: process.env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: process.env.SLACK_REDIRECT_URI,
    }),
  });
  const result = await response.json();
  if (!result.ok || !result.authed_user?.access_token) throw new Error(result.error ?? "Slack token request failed.");

  await store.saveConnection(sessionId, {
    enabled: true,
    userId: result.authed_user.id,
    team: { id: result.team?.id, name: result.team?.name },
    tokens: { accessToken: result.authed_user.access_token },
  });
}

export async function connectionSummary(sessionId) {
  const connection = await store.readConnection(sessionId);
  return {
    configured: slackOAuthConfigured(),
    connected: Boolean(connection),
    enabled: connection?.enabled ?? false,
    connectedAt: connection?.connectedAt ?? null,
    team: connection?.team?.name ?? null,
  };
}

export async function setConnectionEnabled(sessionId, enabled) {
  const changed = await store.updateConnection(sessionId, { enabled });
  if (!changed) throw new Error("Connect Slack before enabling it.");
}

// Slack stores mentions and links as <@U123>, <#C123|general> and <https://x|label>.
export function cleanText(text, names = {}) {
  return (text ?? "")
    .replace(/<@(\w+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label ?? names[id] ?? "someone"}`)
    .replace(/<#\w+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

// A DM needs a reply when the newest message in it came from the other person recently.
export function needsReply(message, me, since) {
  return Boolean(message) && message.user !== me && !message.subtype && Number(message.ts) >= since;
}

export function toItem({ kind, channel, where, from, text, ts, url }, names) {
  return {
    id: `${channel}:${ts}`,
    kind,
    from,
    where,
    text: cleanText(text, names),
    sentAt: new Date(Number(ts) * 1000).toISOString(),
    url,
  };
}

async function loadMentions(token, me, since) {
  const result = await slackApi(token, "search.messages", { query: `<@${me}>`, sort: "timestamp", sort_dir: "desc", count: 50 });
  return (result.messages?.matches ?? [])
    .filter((match) => match.user !== me && Number(match.ts) >= since)
    .map((match) => ({
      kind: "mention",
      channel: match.channel?.id,
      where: match.channel?.is_im ? "Direct message" : `#${match.channel?.name ?? "channel"}`,
      from: match.username ?? "Someone",
      text: match.text,
      ts: match.ts,
      url: match.permalink,
    }));
}

async function loadUnansweredDms(token, me, since) {
  const { channels = [] } = await slackApi(token, "conversations.list", { types: "im", exclude_archived: true, limit: 200 });
  // ponytail: one history call per DM; fine for a team workspace, batch or cache if users have hundreds of DMs.
  const latest = await Promise.all(channels.map(async (im) => {
    const { messages = [] } = await slackApi(token, "conversations.history", { channel: im.id, limit: 1 });
    return { im, message: messages[0] };
  }));
  const pending = latest.filter(({ message }) => needsReply(message, me, since));
  return Promise.all(pending.map(async ({ im, message }) => {
    const [{ user }, { permalink }] = await Promise.all([
      slackApi(token, "users.info", { user: im.user }),
      slackApi(token, "chat.getPermalink", { channel: im.id, message_ts: message.ts }),
    ]);
    return {
      kind: "dm",
      channel: im.id,
      where: "Direct message",
      from: user?.profile?.display_name || user?.real_name || user?.name || "Someone",
      text: message.text,
      ts: message.ts,
      url: permalink,
    };
  }));
}

export async function getMessagesForSession(sessionId) {
  const connection = await store.readConnection(sessionId);
  if (!connection) throw new Error("Connect Slack in Settings to load messages.");
  if (!connection.enabled) throw new Error("Slack is disabled in Settings.");
  const token = connection.tokens.accessToken;
  const since = Date.now() / 1000 - lookback;
  const [mentions, dms] = await Promise.all([loadMentions(token, connection.userId, since), loadUnansweredDms(token, connection.userId, since)]);

  const byId = new Map();
  for (const message of [...dms, ...mentions]) {
    const item = toItem(message, { [connection.userId]: "you" });
    if (!byId.has(item.id)) byId.set(item.id, item);
  }
  return [...byId.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
}
