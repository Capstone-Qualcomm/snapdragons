import type { OutlookConnection } from "./outlook-auth.ts";

export type OutlookMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
};

export type OutlookThreadMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  content: string;
};

type GraphMessage = {
  id?: unknown;
  conversationId?: unknown;
  isRead?: unknown;
  from?: { emailAddress?: { name?: unknown; address?: unknown } };
  subject?: unknown;
  receivedDateTime?: unknown;
  uniqueBody?: { content?: unknown };
  body?: { content?: unknown };
};

type OutlookApiOptions = {
  outlookConnection: OutlookConnection;
  fetchImpl?: typeof fetch;
  getAccessToken: () => Promise<string>;
};

const graphOrigin = "https://graph.microsoft.com";

export function createOutlookApi({ outlookConnection, fetchImpl = globalThis.fetch, getAccessToken }: OutlookApiOptions) {
  async function getUnreadMessages(): Promise<OutlookMessage[]> {
    if (!outlookConnection.connected) throw new Error("Outlook is not connected. Connect Outlook.");
    const accessToken = await getAccessToken();
    const items: OutlookMessage[] = [];
    const first = new URL(`${graphOrigin}/v1.0/me/mailFolders/inbox/messages`);
    const receivedAfter = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    // Graph requires the ordered property first in the filter when both are used.
    first.searchParams.set("$filter", `receivedDateTime ge ${receivedAfter} and isRead eq false`);
    first.searchParams.set("$select", "id,isRead,from,subject,receivedDateTime");
    first.searchParams.set("$orderby", "receivedDateTime desc");
    first.searchParams.set("$top", "50");
    let next: string | null = first.toString();

    while (next) {
      const pageUrl = new URL(next);
      if (pageUrl.origin !== graphOrigin) throw new Error("Microsoft Graph returned an unexpected page URL.");
      const response = await fetchImpl(pageUrl, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (response.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
      if (response.status === 403) throw new Error("Outlook denied read access. Check the app's delegated Mail.Read permission.");
      if (!response.ok) throw new Error(`Outlook could not load unread messages (HTTP ${response.status}). Please try again.`);
      const result = await response.json() as { value?: unknown; "@odata.nextLink"?: unknown };
      if (!Array.isArray(result.value)) throw new Error("Microsoft Graph returned an unexpected message list.");
      items.push(...result.value.filter(isUnreadMessage).map(toMessage));
      next = typeof result["@odata.nextLink"] === "string" ? result["@odata.nextLink"] : null;
    }
    return items;
  }

  async function getConversation(messageId: string): Promise<OutlookThreadMessage[]> {
    if (!outlookConnection.connected) throw new Error("Outlook is not connected. Connect Outlook.");
    if (!outlookConnection.enabled) throw new Error("Outlook is turned off. Turn it on.");
    if (!messageId) throw new Error("An Outlook message ID is required.");
    const accessToken = await getAccessToken();
    const currentResponse = await fetchImpl(`${graphOrigin}/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=conversationId`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (currentResponse.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
    if (currentResponse.status === 403) throw new Error("Outlook denied read access. Check the delegated Mail.Read permission.");
    if (currentResponse.status === 404) throw new Error("This Outlook message could not be found. Refresh the list and try again.");
    if (!currentResponse.ok) throw new Error(`Outlook could not load this conversation (HTTP ${currentResponse.status}). Please try again.`);
    const current = await currentResponse.json() as GraphMessage;
    if (typeof current.conversationId !== "string" || !current.conversationId) {
      throw new Error("Outlook did not return a conversation ID for this message.");
    }

    const conversationId = current.conversationId.replace(/'/g, "''");
    const first = new URL(`${graphOrigin}/v1.0/me/messages`);
    first.searchParams.set("$filter", `conversationId eq '${conversationId}'`);
    first.searchParams.set("$select", "id,from,subject,receivedDateTime,uniqueBody,body");
    first.searchParams.set("$top", "50");
    const thread: OutlookThreadMessage[] = [];
    let next: string | null = first.toString();
    while (next) {
      const pageUrl = new URL(next);
      if (pageUrl.origin !== graphOrigin) throw new Error("Microsoft Graph returned an unexpected page URL.");
      const response = await fetchImpl(pageUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Prefer: 'outlook.body-content-type="text"',
        },
      });
      if (response.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
      if (response.status === 403) throw new Error("Outlook denied read access. Check the delegated Mail.Read permission.");
      if (!response.ok) throw new Error(`Outlook could not load this conversation (HTTP ${response.status}). Please try again.`);
      const result = await response.json() as { value?: unknown; "@odata.nextLink"?: unknown };
      if (!Array.isArray(result.value)) throw new Error("Microsoft Graph returned an unexpected conversation.");
      thread.push(...result.value.filter(isThreadMessage).map(toThreadMessage));
      next = typeof result["@odata.nextLink"] === "string" ? result["@odata.nextLink"] : null;
    }
    return thread.sort((a, b) => Date.parse(a.receivedAt) - Date.parse(b.receivedAt));
  }

  async function markAsRead(messageId: string): Promise<void> {
    await updateMessage(messageId, { isRead: true });
  }

  async function deleteMessage(messageId: string): Promise<void> {
    await updateMessage(messageId, undefined, "DELETE");
  }

  async function replyToMessage(messageId: string, comment: string): Promise<boolean> {
    if (!outlookConnection.connected) throw new Error("Outlook is not connected. Connect Outlook.");
    if (!outlookConnection.enabled) throw new Error("Outlook is turned off. Turn it on.");
    if (!messageId) throw new Error("An Outlook message ID is required.");
    if (!comment.trim()) throw new Error("Write a reply before sending.");
    const accessToken = await getAccessToken();
    const response = await fetchImpl(`${graphOrigin}/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        message: {
          body: {
            contentType: "HTML",
            content: formatReplyBody(comment),
          },
        },
      }),
    });
    if (response.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
    if (response.status === 403) throw new Error("Outlook denied permission to send mail. Check the delegated Mail.Send permission and reconnect.");
    if (response.status === 404) throw new Error("This Outlook message could not be found. Refresh the list and try again.");
    if (!response.ok) throw new Error(`Outlook could not send this reply (HTTP ${response.status}). Please try again.`);

    // Sending is irreversible, so a subsequent read-state failure must not be
    // reported as a failed reply that could prompt the user to send it twice.
    try {
      await updateMessage(messageId, { isRead: true });
      return true;
    } catch {
      return false;
    }
  }

  async function updateMessage(messageId: string, changes?: Record<string, unknown>, method: "PATCH" | "DELETE" = "PATCH"): Promise<void> {
    if (!outlookConnection.connected) throw new Error("Outlook is not connected. Connect Outlook.");
    if (!outlookConnection.enabled) throw new Error("Outlook is turned off. Turn it on.");
    if (!messageId) throw new Error("An Outlook message ID is required.");
    const accessToken = await getAccessToken();
    const response = await fetchImpl(`${graphOrigin}/v1.0/me/messages/${encodeURIComponent(messageId)}`, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(changes ? { "Content-Type": "application/json" } : {}),
      },
      ...(changes ? { body: JSON.stringify(changes) } : {}),
    });
    if (response.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
    if (response.status === 403) throw new Error("Outlook denied permission to change mail. Check the delegated Mail.ReadWrite permission and reconnect.");
    if (response.status === 404) throw new Error("This Outlook message could not be found. Refresh the list and try again.");
    if (!response.ok) throw new Error(`Outlook could not ${method === "DELETE" ? "delete" : "mark as read"} this message (HTTP ${response.status}). Please try again.`);
  }

  return { getUnreadMessages, getConversation, markAsRead, deleteMessage, replyToMessage };
}

function formatReplyBody(text: string): string {
  const escapeHtml = (value: string) => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
  return text.replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

function isUnreadMessage(value: unknown): value is GraphMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as GraphMessage;
  return message.isRead === false
    && typeof message.id === "string"
    && typeof message.receivedDateTime === "string";
}

function isThreadMessage(value: unknown): value is GraphMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as GraphMessage;
  return typeof message.id === "string" && typeof message.receivedDateTime === "string";
}

function toMessage(message: GraphMessage): OutlookMessage {
  const sender = message.from?.emailAddress;
  return {
    id: message.id as string,
    from: typeof sender?.name === "string" ? sender.name : typeof sender?.address === "string" ? sender.address : "Unknown sender",
    subject: typeof message.subject === "string" && message.subject ? message.subject : "(no subject)",
    receivedAt: message.receivedDateTime as string,
  };
}

function toThreadMessage(message: GraphMessage): OutlookThreadMessage {
  const sender = message.from?.emailAddress;
  const body = typeof message.uniqueBody?.content === "string"
    ? message.uniqueBody.content
    : typeof message.body?.content === "string" ? message.body.content : "";
  return {
    id: message.id as string,
    from: typeof sender?.name === "string" ? sender.name : typeof sender?.address === "string" ? sender.address : "Unknown sender",
    subject: typeof message.subject === "string" && message.subject ? message.subject : "(no subject)",
    receivedAt: message.receivedDateTime as string,
    content: body,
  };
}
