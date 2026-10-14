import assert from "node:assert/strict";
import { test } from "node:test";
import { createGitHubApi } from "./github-api.ts";

function apiItem(overrides: Record<string, unknown> = {}) {
  return {
    number: 12,
    title: "Fix the report",
    state: "open",
    updated_at: "2026-10-13T12:00:00Z",
    html_url: "https://github.com/example/repo/issues/12",
    repository: { full_name: "example/repo" },
    ...overrides,
  };
}

test("converts assigned issues and pull requests and filters closed items", async () => {
  const api = createGitHubApi({
    fetchImpl: async () => new Response(JSON.stringify([
      apiItem(),
      apiItem({ number: 13, title: "Review the change", pull_request: { html_url: "https://github.com/example/repo/pull/13" } }),
      apiItem({ number: 14, state: "closed" }),
    ]), { status: 200 }),
  });

  const items = await api.getAssignedOpenIssues("test-token");

  assert.equal(items.length, 2);
  assert.deepEqual(items.map(({ kind, number, url }) => ({ kind, number, url })), [
    { kind: "issue", number: 12, url: "https://github.com/example/repo/issues/12" },
    { kind: "pull_request", number: 13, url: "https://github.com/example/repo/pull/13" },
  ]);
  assert.equal(items[0].id, "github:example/repo#12");
});

test("follows the next Link page and includes its assigned items", async () => {
  const requested: string[] = [];
  const api = createGitHubApi({
    fetchImpl: async (input) => {
      requested.push(String(input));
      if (requested.length === 1) {
        return new Response(JSON.stringify([apiItem()]), {
          status: 200,
          headers: { Link: '<https://api.github.com/issues?page=2>; rel="next", <https://api.github.com/issues?page=2>; rel="last"' },
        });
      }
      return new Response(JSON.stringify([apiItem({ number: 13 })]), { status: 200 });
    },
  });

  const items = await api.getAssignedOpenIssues("test-token");

  assert.equal(requested.length, 2);
  assert.match(requested[0], /filter=assigned/);
  assert.deepEqual(items.map((item) => item.number), [12, 13]);
});

test("reports expired authorization and permission/rate-limit failures", async (context) => {
  for (const [status, expected] of [
    [401, /authorization expired/i],
    [403, /denied access or the API rate limit/i],
  ] as const) {
    await context.test(`HTTP ${status}`, async () => {
      const api = createGitHubApi({ fetchImpl: async () => new Response("{}", { status }) });
      await assert.rejects(api.getAssignedOpenIssues("test-token"), expected);
    });
  }
});
