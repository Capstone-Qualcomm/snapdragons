import type { NotionConnection } from "./notion-auth.ts";

const notionVersion = "2026-03-11";
const pageSize = 100;

export type NotionPage = {
  id: string;
  title: string;
  updatedAt: string;
  url: string;
};

type SearchPage = {
  object?: string;
  id?: string;
  url?: string;
  last_edited_time?: string;
  in_trash?: boolean;
  properties?: Record<string, unknown>;
};

type SearchResponse = {
  results?: SearchPage[];
  has_more?: boolean;
  next_cursor?: string | null;
};

type NotionApiOptions = {
  notionConnection: NotionConnection;
  fetchImpl: typeof fetch;
  getAccessToken: (forceRefresh?: boolean) => Promise<string>;
};

export function createNotionApi({ notionConnection, fetchImpl, getAccessToken }: NotionApiOptions) {
  async function search(query?: string, cursor?: string): Promise<SearchResponse> {
    const request = async (forceRefresh = false) => {
      const accessToken = await getAccessToken(forceRefresh);
      return fetchImpl("https://api.notion.com/v1/search?filter_properties=title", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "Notion-Version": notionVersion,
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          filter: { property: "object", value: "page" },
          page_size: pageSize,
          sort: { direction: "descending", timestamp: "last_edited_time" },
          ...(query ? { query } : {}),
          ...(cursor ? { start_cursor: cursor } : {}),
        }),
      });
    };

    let response = await request();
    if (response.status === 401) response = await request(true);
    if (!response.ok) {
      if (response.status === 401) throw new Error("Notion authorization expired. Reconnect Notion.");
      if (response.status === 403) throw new Error("Notion denied access to shared pages. Check the pages shared with this connection.");
      if (response.status === 429) throw new Error("Notion is busy. Wait a moment and refresh the report.");
      throw new Error(`Notion could not load shared pages (${response.status}).`);
    }
    return await response.json() as SearchResponse;
  }

  function pageTitle(properties: Record<string, unknown> = {}): string {
    for (const property of Object.values(properties)) {
      if (!property || typeof property !== "object") continue;
      const value = property as { type?: string; title?: Array<{ plain_text?: string; text?: { content?: string } }> };
      if (value.type !== "title" && !Array.isArray(value.title)) continue;
      const title = (value.title ?? []).map((part) => part.plain_text ?? part.text?.content ?? "").join("").trim();
      if (title) return title;
    }
    return "Untitled";
  }

  async function getPages(query = ""): Promise<NotionPage[]> {
    if (!notionConnection.connected || !notionConnection.token) {
      throw new Error("Notion is not connected. Connect Notion.");
    }

    const pages: NotionPage[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await search(query.trim() || undefined, cursor);
      for (const page of result.results ?? []) {
        if (page.object !== "page" || !page.id || !page.url || page.in_trash) continue;
        pages.push({
          id: page.id,
          title: pageTitle(page.properties),
          updatedAt: page.last_edited_time ?? "",
          url: page.url,
        });
      }
      if (result.has_more && !result.next_cursor) throw new Error("Notion indicated more pages without returning a page cursor.");
      const next = result.has_more ? result.next_cursor ?? undefined : undefined;
      if (!next) break;
      if (seen.has(next)) throw new Error("Notion returned a repeated page cursor. Try refreshing again.");
      seen.add(next);
      cursor = next;
    } while (cursor);

    return pages;
  }

  return { getPages };
}
