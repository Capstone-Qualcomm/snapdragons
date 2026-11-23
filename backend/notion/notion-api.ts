import type { NotionConnection } from "./notion-auth.ts";

export type NotionPage = { id: string; title: string; url: string; text: string; editedAt: string | null };

type NotionApiOptions = { connection: NotionConnection; fetchImpl?: typeof fetch };
type SearchResponse = { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };
type ChildrenResponse = { results?: unknown[]; has_more?: boolean; next_cursor?: string | null };

const API = "https://api.notion.com/v1";
const NOTION_VERSION = "2026-03-11";
const MAX_PAGES = 5;
const MAX_PAGE_CHARS = 5_000;
const MAX_DEPTH = 4;

function richText(value: unknown): string {
  if (!Array.isArray(value)) return "";
  return value.map((part) => {
    if (!part || typeof part !== "object") return "";
    const entry = part as Record<string, unknown>;
    return typeof entry.plain_text === "string" ? entry.plain_text : "";
  }).join("");
}

function titleOf(page: Record<string, unknown>): string {
  const properties = page.properties;
  if (properties && typeof properties === "object") {
    for (const value of Object.values(properties as Record<string, unknown>)) {
      if (!value || typeof value !== "object") continue;
      const property = value as Record<string, unknown>;
      if (property.type === "title") return richText(property.title);
      if (Array.isArray(property.title)) return richText(property.title);
    }
  }
  const title = page.title;
  return richText(title) || "Untitled page";
}

function plainBlock(block: unknown): { text: string; children: boolean; id: string } | null {
  if (!block || typeof block !== "object") return null;
  const item = block as Record<string, unknown>;
  const type = typeof item.type === "string" ? item.type : "";
  const body = item[type];
  const data = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const line = richText(data.rich_text) || (typeof data.title === "string" ? data.title : "");
  return { text: line, children: item.has_children === true, id: typeof item.id === "string" ? item.id : "" };
}

export function createNotionApi({ connection, fetchImpl = globalThis.fetch }: NotionApiOptions) {
  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const token = connection.token;
    if (!connection.connected || !token) throw new Error("Notion is not connected. Connect Notion.");
    const response = await fetchImpl(`${API}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json",
        ...init.headers,
      },
    });
    if (response.status === 401) throw new Error("Notion authorization expired. Reconnect Notion.");
    if (response.status === 403) throw new Error("Notion denied access to a shared page. Check the integration’s page access.");
    if (response.status === 429) throw new Error("Notion is rate limiting requests. Try again shortly.");
    if (!response.ok) throw new Error(`Notion could not load pages (HTTP ${response.status}).`);
    return await response.json() as T;
  }

  async function readChildren(blockId: string, remaining: number, depth: number): Promise<string> {
    if (remaining <= 0 || depth > MAX_DEPTH) return "";
    let cursor: string | undefined;
    let result = "";
    do {
      const url = new URL(`${API}/blocks/${encodeURIComponent(blockId)}/children`);
      url.searchParams.set("page_size", "100");
      if (cursor) url.searchParams.set("start_cursor", cursor);
      const page = await request<ChildrenResponse>(url.toString().slice(API.length));
      for (const raw of page.results ?? []) {
        const block = plainBlock(raw);
        if (!block) continue;
        const line = block.text ? `${block.text}\n` : "";
        result += line.slice(0, Math.max(0, remaining - result.length));
        if (result.length >= remaining) return result;
        if (block.children && block.id) {
          result += await readChildren(block.id, remaining - result.length, depth + 1);
          if (result.length >= remaining) return result;
        }
      }
      cursor = page.has_more && page.next_cursor ? page.next_cursor : undefined;
    } while (cursor && result.length < remaining);
    return result;
  }

  async function searchPages(query: string): Promise<NotionPage[]> {
    const cleanQuery = query.trim().slice(0, 200);
    if (!cleanQuery) throw new Error("Enter a question to search Notion.");
    const page = await request<SearchResponse>("/search", {
      method: "POST",
      body: JSON.stringify({
        query: cleanQuery,
        filter: { property: "object", value: "page" },
        sort: { direction: "descending", timestamp: "last_edited_time" },
        page_size: MAX_PAGES,
      }),
    });
    const candidates = (page.results ?? []).filter((item): item is Record<string, unknown> => !!item && typeof item === "object");
    const pages: NotionPage[] = [];
    for (const item of candidates.slice(0, MAX_PAGES)) {
      if (typeof item.id !== "string" || typeof item.url !== "string") continue;
      const url = new URL(item.url);
      if (url.protocol !== "https:" || !/(^|\.)notion\.so$/.test(url.hostname)) continue;
      const title = titleOf(item);
      const text = await readChildren(item.id, MAX_PAGE_CHARS, 0);
      pages.push({ id: item.id, title, url: url.toString(), text, editedAt: typeof item.last_edited_time === "string" ? item.last_edited_time : null });
    }
    return pages;
  }

  return { searchPages };
}
