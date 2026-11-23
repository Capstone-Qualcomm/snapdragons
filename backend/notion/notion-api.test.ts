import assert from "node:assert/strict";
import { test } from "node:test";
import { createNotionApi } from "./notion-api.ts";
import type { NotionConnection } from "./notion-auth.ts";

const connection = (): NotionConnection => ({ connected: true, enabled: true, connectedAt: null, workspaceId: "w1", workspaceName: "Team", ownerName: null, token: "secret-token" });
const textBlock = (value: string) => ({ object: "block", id: `b-${value}`, type: "paragraph", has_children: false, paragraph: { rich_text: [{ plain_text: value }] } });

test("searches by title, reads nested and paginated page blocks, and returns only safe source fields", async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const api = createNotionApi({ connection: connection(), fetchImpl: async (input, init) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.endsWith("/search")) return Response.json({ results: [{
      object: "page",
      id: "p1",
      url: "https://www.notion.so/team/Release-Plan-p1",
      last_edited_time: "2026-11-01",
      properties: { Name: { type: "title", title: [{ plain_text: "Release Plan" }] } },
    }] });
    if (url.includes("start_cursor=next")) return Response.json({ results: [textBlock("Owner: Alex")], has_more: false });
    if (url.includes("/blocks/b-Release%20is%20Friday/children")) return Response.json({ results: [textBlock("b-block")], has_more: false });
    if (url.includes("/blocks/p1/children")) return Response.json({ results: [{ ...textBlock("Release is Friday"), has_children: true }], has_more: true, next_cursor: "next" });
    return Response.json({}, { status: 404 });
  } });

  const pages = await api.searchPages("release plan");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].title, "Release Plan");
  assert.equal(pages[0].text, "Release is Friday\nb-block\nOwner: Alex\n");
  assert.equal(pages[0].url, "https://www.notion.so/team/Release-Plan-p1");
  assert.ok(calls[0].url.endsWith("/search"));
  assert.match(String(calls[0].init?.body), /"query":"release plan"/);
  assert.ok(calls.every(({ init }) => (init?.headers as Record<string, string>).Authorization === "Bearer secret-token"));
});

test("limits returned content per page and ignores non-Notion URLs", async () => {
  const api = createNotionApi({ connection: connection(), fetchImpl: async (input) => {
    const url = String(input);
    if (url.endsWith("/search")) return Response.json({ results: [
      { object: "page", id: "p1", url: "https://evil.example/page", properties: { Title: { type: "title", title: [{ plain_text: "Bad" }] } } },
      { object: "page", id: "p2", url: "https://notion.so/large", properties: { Title: { type: "title", title: [{ plain_text: "Large" }] } } },
    ] });
    return Response.json({ results: Array.from({ length: 100 }, (_, index) => textBlock("x".repeat(100) + index)), has_more: true, next_cursor: "next" });
  } });
  const pages = await api.searchPages("large");
  assert.equal(pages.length, 1);
  assert.equal(pages[0].text.length, 5_000);
});

test("rejects expired tokens and handles Notion rate limits without leaking credentials", async () => {
  const expired = createNotionApi({ connection: { ...connection(), connected: false, token: null } });
  await assert.rejects(expired.searchPages("test"), /Notion is not connected/);
  const limited = createNotionApi({ connection: connection(), fetchImpl: async () => Response.json({}, { status: 429 }) });
  await assert.rejects(limited.searchPages("test"), /rate limiting/);
});
