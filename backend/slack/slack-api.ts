import type { SlackConnection } from "./slack-auth.ts";

type SlackApiOptions = {
  slackConnection: SlackConnection;
  fetchImpl: typeof fetch;
};

export type SlackMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

export type SlackContextMessage = { id: string; from: string; sentAt: string; text: string };

const lookback = 3 * 24 * 60 * 60;

export function createSlackApi({ slackConnection, fetchImpl }: SlackApiOptions) {
  async function slackRequest(method: string, params: Record<string, string> = {}, post = false): Promise<Record<string, unknown>> {
    const token = slackConnection.token?.accessToken;
    if (!token) throw new Error("Slack is not connected. Connect Slack.");
    const url = new URL(`https://slack.com/api/${method}`);
    const init: RequestInit = { headers: { Authorization: `Bearer ${token}` } };
    if (post) {
      init.method = "POST";
      init.headers = { ...init.headers, "Content-Type": "application/json; charset=utf-8" };
      init.body = JSON.stringify(params);
    } else {
      for (const [name, value] of Object.entries(params)) url.searchParams.set(name, String(value));
    }
    const response = await fetchImpl(url, init);
    const result = await response.json() as Record<string, unknown>;
    if (!result.ok) {
      if (["invalid_auth", "token_revoked", "token_expired", "not_authed", "account_inactive"].includes(String(result.error))) {
        throw new Error("Slack authorization expired. Reconnect Slack.");
      }
      throw new Error(`Slack returned ${result.error ?? "an error"} while loading messages.`);
    }
    return result;
  }

  function cleanText(text: string | undefined, names: Record<string, string> = {}): string {
    return (text ?? "")
      .replace(/<@(\w+)(?:\|([^>]+))?>/g, (_: string, id: string, label: string) => `@${label ?? names[id] ?? "someone"}`)
      .replace(/<#\w+\|([^>]+)>/g, "#$1")
      .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
      .replace(/<(https?:[^>]+)>/g, "$1")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&amp;/g, "&");
  }

  function needsReply(message: Record<string, unknown> | undefined, me: string, since: number): boolean {
    if (!message) return false;
    return message.user !== me && !message.subtype && Number(message.ts) >= since;
  }

  function toItem(raw: { kind: string; channel: string; where: string; from: string; text: string; ts: string; url: string }, names: Record<string, string>): SlackMessage {
    return {
      id: `${raw.channel}:${raw.ts}`,
      kind: raw.kind as "mention" | "dm",
      from: raw.from,
      where: raw.where,
      text: cleanText(raw.text, names),
      sentAt: new Date(Number(raw.ts) * 1000).toISOString(),
      url: raw.url,
    };
  }

  async function loadMentions(me: string, since: number) {
    const result = await slackRequest("search.messages", { query: `<@${me}>`, sort: "timestamp", sort_dir: "desc", count: "50" });
    const matches = (result.messages as { matches?: Array<Record<string, unknown>> })?.matches ?? [];
    return matches
      .filter((match) => match.user !== me && Number(match.ts) >= since)
      .map((match) => ({
        kind: "mention",
        channel: String(match.channel && typeof match.channel === "object" ? (match.channel as Record<string, unknown>).id ?? "" : ""),
        where: match.channel && typeof match.channel === "object" && (match.channel as Record<string, unknown>).is_im
          ? "Direct message"
          : `#${match.channel && typeof match.channel === "object" ? (match.channel as Record<string, unknown>).name ?? "channel" : "channel"}`,
        from: String(match.username ?? "Someone"),
        text: String(match.text ?? ""),
        ts: String(match.ts ?? "0"),
        url: String(match.permalink ?? ""),
      }));
  }

  async function loadUnansweredDms(me: string, since: number) {
    const { channels } = await slackRequest("conversations.list", { types: "im", exclude_archived: "true", limit: "200" }) as { channels?: Array<Record<string, unknown>> };
    const ims = (channels ?? []).filter((im) => !im.is_user_deleted);
    // One DM Slack won't read (rate limited, gone) skips that DM instead of failing the whole list.
    const latest = settled(await Promise.allSettled(ims.map(async (im) => {
      const { messages } = await slackRequest("conversations.history", { channel: String(im.id ?? ""), limit: "1" }) as { messages?: Array<Record<string, unknown>> };
      return { im, message: messages?.[0] };
    })));
    const pending = latest.filter(({ message }) => needsReply(message, me, since));
    return settled(await Promise.allSettled(pending.map(async ({ im, message }) => {
      const [userResult, permalinkResult] = await Promise.all([
        slackRequest("users.info", { user: String(im.user ?? "") }) as Promise<{ user?: Record<string, unknown> }>,
        slackRequest("chat.getPermalink", { channel: String(im.id ?? ""), message_ts: String(message!.ts) }) as Promise<{ permalink?: string }>,
      ]);
      const user = userResult.user;
      return {
        kind: "dm",
        channel: String(im.id ?? ""),
        where: "Direct message",
        from: String(user?.profile && typeof user.profile === "object"
          ? ((user.profile as Record<string, unknown>).display_name || (user.profile as Record<string, unknown>).real_name)
          : user?.real_name || user?.name || "Someone"),
        text: String(message!.text ?? ""),
        ts: String(message!.ts),
        url: String(permalinkResult.permalink ?? ""),
      };
    })));
  }

  // The results that came back, unless Slack signed the user out, which the user has to see.
  function settled<T>(results: PromiseSettledResult<T>[]): T[] {
    const signedOut = results.find((result) => result.status === "rejected" && String(result.reason?.message).includes("Reconnect Slack"));
    if (signedOut) throw (signedOut as PromiseRejectedResult).reason;
    return results.flatMap((result) => result.status === "fulfilled" ? [result.value] : []);
  }

  async function getMessages(): Promise<SlackMessage[]> {
    const me = slackConnection.userId ?? "";
    const since = Date.now() / 1000 - lookback;
    const [mentions, dms] = await Promise.all([
      loadMentions(me, since),
      loadUnansweredDms(me, since),
    ]);

    const byId = new Map<string, SlackMessage>();
    const names = { [me]: "you" };
    for (const raw of [...dms, ...mentions]) {
      const item = toItem(raw, names);
      if (!byId.has(item.id)) byId.set(item.id, item);
    }
    return [...byId.values()].sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  async function sendMessage(channel: string, text: string) {
    const result = await slackRequest("chat.postMessage", { channel, text }, true);
    return { ok: true, ts: String(result.ts ?? "") };
  }

  async function getContext(channel: string): Promise<SlackContextMessage[]> {
    const info = await slackRequest("conversations.info", { channel }) as { channel?: Record<string, unknown> };
    const lastRead = String(info.channel?.last_read ?? "0");

    const messages: Array<Record<string, unknown>> = [];
    let cursor = "";
    do {
      const result = await slackRequest("conversations.history", {
        channel,
        oldest: lastRead,
        limit: "100",
        ...(cursor ? { cursor } : {}),
      }) as { messages?: Array<Record<string, unknown>>; response_metadata?: { next_cursor?: string } };
      messages.push(...(result.messages ?? []));
      cursor = result.response_metadata?.next_cursor ?? "";
    } while (cursor);

    const me = slackConnection.userId ?? "";
    const authors = [...new Set(messages.map((message) => String(message.user ?? "")).filter((user) => user && user !== me))];
    const names = new Map<string, string>();
    await Promise.all(authors.map(async (userId) => {
      try {
        const result = await slackRequest("users.info", { user: userId }) as { user?: Record<string, unknown> };
        const profile = result.user?.profile && typeof result.user.profile === "object" ? result.user.profile as Record<string, unknown> : {};
        names.set(userId, String(profile.display_name || profile.real_name || result.user?.real_name || result.user?.name || "Someone"));
      } catch { names.set(userId, "Someone"); }
    }));
    return messages.reverse().map((message) => ({
      id: String(message.ts ?? ""),
      from: String(message.user ?? "") === me ? "You" : names.get(String(message.user ?? "")) ?? "Someone",
      sentAt: new Date(Number(message.ts ?? 0) * 1000).toISOString(),
      text: cleanText(String(message.text ?? ""), { [me]: "you" }),
    }));
  }

  return { getMessages, getContext, sendMessage, cleanText, needsReply, toItem };
}
