import type { OutlookConnection } from "./outlook-auth.ts";

export type OutlookMessage = {
  id: string;
  from: string;
  subject: string;
  receivedAt: string;
  url: string;
};

type GraphMessage = {
  id?: unknown;
  isRead?: unknown;
  from?: { emailAddress?: { name?: unknown; address?: unknown } };
  subject?: unknown;
  receivedDateTime?: unknown;
  webLink?: unknown;
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
    first.searchParams.set("$select", "id,isRead,from,subject,receivedDateTime,webLink");
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

  async function markAsRead(messageId: string): Promise<void> {
    await updateMessage(messageId, { isRead: true });
  }

  async function deleteMessage(messageId: string): Promise<void> {
    await updateMessage(messageId, undefined, "DELETE");
  }

  async function replyToMessage(messageId: string, comment: string): Promise<void> {
    if (!outlookConnection.connected) throw new Error("Outlook is not connected. Connect Outlook.");
    if (!outlookConnection.enabled) throw new Error("Outlook is turned off. Turn it on.");
    if (!messageId) throw new Error("An Outlook message ID is required.");
    if (!comment.trim()) throw new Error("Write a reply before sending.");
    const accessToken = await getAccessToken();
    const response = await fetchImpl(`${graphOrigin}/v1.0/me/messages/${encodeURIComponent(messageId)}/reply`, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ comment }),
    });
    if (response.status === 401) throw new Error("Outlook authorization expired. Reconnect Outlook.");
    if (response.status === 403) throw new Error("Outlook denied permission to send mail. Check the delegated Mail.Send permission and reconnect.");
    if (response.status === 404) throw new Error("This Outlook message could not be found. Refresh the list and try again.");
    if (!response.ok) throw new Error(`Outlook could not send this reply (HTTP ${response.status}). Please try again.`);
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

  return { getUnreadMessages, markAsRead, deleteMessage, replyToMessage };
}

function isUnreadMessage(value: unknown): value is GraphMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as GraphMessage;
  return message.isRead === false
    && typeof message.id === "string"
    && typeof message.receivedDateTime === "string";
}

function toMessage(message: GraphMessage): OutlookMessage {
  const sender = message.from?.emailAddress;
  return {
    id: message.id as string,
    from: typeof sender?.name === "string" ? sender.name : typeof sender?.address === "string" ? sender.address : "Unknown sender",
    subject: typeof message.subject === "string" && message.subject ? message.subject : "(no subject)",
    receivedAt: message.receivedDateTime as string,
    url: typeof message.webLink === "string" ? message.webLink : "https://outlook.office.com/mail/inbox",
  };
}
