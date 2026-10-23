import type { OutlookConnection } from "./outlook-auth.ts";

export type OutlookMessage = {
  id: string;
  from: string;
  subject: string;
  preview: string;
  receivedAt: string;
  url: string;
};

type GraphMessage = {
  id?: unknown;
  isRead?: unknown;
  from?: { emailAddress?: { name?: unknown; address?: unknown } };
  subject?: unknown;
  bodyPreview?: unknown;
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
    first.searchParams.set("$filter", "isRead eq false");
    first.searchParams.set("$select", "id,isRead,from,subject,bodyPreview,receivedDateTime,webLink");
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

  return { getUnreadMessages };
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
    preview: typeof message.bodyPreview === "string" ? message.bodyPreview : "",
    receivedAt: message.receivedDateTime as string,
    url: typeof message.webLink === "string" ? message.webLink : "https://outlook.office.com/mail/inbox",
  };
}
