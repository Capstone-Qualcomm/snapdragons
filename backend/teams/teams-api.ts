import type { TeamsConnection } from "./teams-auth.ts";

export type TeamsMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

type GraphChat = { id?: unknown; chatType?: unknown; topic?: unknown; lastUpdatedDateTime?: unknown };
type GraphChatMessage = {
  id?: unknown;
  createdDateTime?: unknown;
  from?: { user?: { id?: unknown; displayName?: unknown } };
  body?: { content?: unknown };
  mentions?: Array<{ mentioned?: { user?: { id?: unknown } }; mentionText?: unknown }>;
};

type TeamsApiOptions = { teamsConnection: TeamsConnection; fetchImpl?: typeof fetch; getAccessToken: () => Promise<string> };
const graphOrigin = "https://graph.microsoft.com";
const lookbackMs = 7 * 24 * 60 * 60 * 1000;
const maxChats = 40;

export function createTeamsApi({ teamsConnection, fetchImpl = globalThis.fetch, getAccessToken }: TeamsApiOptions) {
  async function graph(url: URL, accessToken: string): Promise<Record<string, unknown>> {
    if (url.origin !== graphOrigin) throw new Error("Microsoft Graph returned an unexpected page URL.");
    const response = await fetchImpl(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (response.status === 401) throw new Error("Teams authorization expired. Reconnect Teams.");
    if (response.status === 403) throw new Error("Teams denied chat access. Check the delegated Chat.Read permission and reconnect.");
    if (!response.ok) throw new Error(`Teams could not load chats (HTTP ${response.status}). Please try again.`);
    return await response.json() as Record<string, unknown>;
  }

  async function getMessages(): Promise<TeamsMessage[]> {
    if (!teamsConnection.connected) throw new Error("Teams is not connected. Connect Teams.");
    const me = teamsConnection.user?.id;
    if (!me) throw new Error("Teams could not identify the signed-in user. Reconnect Teams.");
    const accessToken = await getAccessToken();
    const chatsUrl = new URL(`${graphOrigin}/v1.0/me/chats`);
    chatsUrl.searchParams.set("$top", "50");
    chatsUrl.searchParams.set("$select", "id,chatType,topic,lastUpdatedDateTime");
    const chatsResponse = await graph(chatsUrl, accessToken);
    if (!Array.isArray(chatsResponse.value)) throw new Error("Microsoft Graph returned an unexpected Teams chat list.");
    const since = Date.now() - lookbackMs;
    const chats = (chatsResponse.value as GraphChat[])
      .filter((chat) => typeof chat.id === "string" && (chat.chatType === "oneOnOne" || chat.chatType === "group"))
      .filter((chat) => typeof chat.lastUpdatedDateTime !== "string" || Date.parse(chat.lastUpdatedDateTime) >= since)
      .sort((a, b) => Date.parse(String(b.lastUpdatedDateTime ?? "")) - Date.parse(String(a.lastUpdatedDateTime ?? "")))
      .slice(0, maxChats);

    const messages: TeamsMessage[] = [];
    // Keep Graph calls bounded so a large chat list does not fan out into a request storm.
    for (let offset = 0; offset < chats.length; offset += 5) {
      const page = await Promise.all(chats.slice(offset, offset + 5).map(async (chat) => {
        const chatId = chat.id as string;
        const messagesUrl = new URL(`${graphOrigin}/v1.0/me/chats/${encodeURIComponent(chatId)}/messages`);
        messagesUrl.searchParams.set("$top", "20");
        // Graph pages messages by lastModifiedDateTime by default. Order by creation
        // time so older pages can be skipped once the seven-day window is passed.
        messagesUrl.searchParams.set("$orderby", "createdDateTime desc");
        const chatMessages: GraphChatMessage[] = [];
        let nextPage: URL | undefined = messagesUrl;
        const visitedPages = new Set<string>();
        while (nextPage) {
          if (visitedPages.has(nextPage.href)) throw new Error("Microsoft Graph returned a repeated Teams message page.");
          visitedPages.add(nextPage.href);
          const result = await graph(nextPage, accessToken);
          if (!Array.isArray(result.value)) throw new Error("Microsoft Graph returned an unexpected Teams message list.");
          const pageMessages = result.value as GraphChatMessage[];
          chatMessages.push(...pageMessages);
          const oldestTimestamp = pageMessages
            .map((message) => typeof message.createdDateTime === "string" ? Date.parse(message.createdDateTime) : Number.NaN)
            .filter(Number.isFinite)
            .reduce((oldest, timestamp) => Math.min(oldest, timestamp), Number.POSITIVE_INFINITY);
          const nextLink = result["@odata.nextLink"];
          nextPage = typeof nextLink === "string" && oldestTimestamp >= since ? new URL(nextLink) : undefined;
        }
        const recent = chatMessages
          .filter((message) => typeof message.id === "string" && typeof message.createdDateTime === "string" && Date.parse(message.createdDateTime) >= since)
          .sort((a, b) => Date.parse(String(b.createdDateTime)) - Date.parse(String(a.createdDateTime)));
        const isDirect = chat.chatType === "oneOnOne";
        const selected = isDirect
          ? recent[0] && typeof recent[0].from?.user?.id === "string" && recent[0].from.user.id !== me ? [recent[0]] : []
          : recent.filter((message) => typeof message.from?.user?.id === "string" && message.from.user.id !== me && message.mentions?.some((mention) => mention.mentioned?.user?.id === me));
        return selected.map((message): TeamsMessage => {
          const sentAt = message.createdDateTime as string;
          const messageId = message.id as string;
          return {
            id: `${chatId}:${messageId}`,
            kind: isDirect ? "dm" : "mention",
            from: typeof message.from?.user?.displayName === "string" ? message.from.user.displayName : "Someone",
            where: typeof chat.topic === "string" && chat.topic ? chat.topic : isDirect ? "Direct chat" : "Group chat",
            text: cleanMessage(typeof message.body?.content === "string" ? message.body.content : ""),
            sentAt,
            url: `https://teams.microsoft.com/l/chat/${encodeURIComponent(chatId)}/0`,
          };
        });
      }));
      messages.push(...page.flat());
    }
    return messages.sort((a, b) => b.sentAt.localeCompare(a.sentAt));
  }

  return { getMessages };
}

function cleanMessage(value: string): string {
  return value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}
