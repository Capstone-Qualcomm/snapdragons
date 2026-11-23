import assert from "node:assert/strict";
import { test } from "node:test";
import { notion } from "./notion.ts";

test("Notion matching pages become parallel read tasks with source URLs in their inputs", () => {
  const page = { id: "p1", title: "Release plan", url: "https://www.notion.so/release", text: "Launch is Friday", editedAt: null };
  const tasks = notion.stages[0].plan([], "When is launch?", { pages: [page] });
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].skill, "read");
  assert.deepEqual(tasks[0].params, { prompt: "When is launch?", page });
  assert.equal(tasks[0].preview?.kind, "page");
});

test("no title matches create a normal job step with a clear result and no model call", async () => {
  const [task] = notion.stages[0].plan([], "Where is the launch plan?", { pages: [] });
  const output = await notion.skills.read(task.params, { partial: null, report: () => {} });
  assert.match(output.summary, /No shared Notion page title matched/);
  const answerTask = notion.stages[1].plan([{ skill: "read", stage: 0, params: null, output, worker: "Q-01" }], "Where is the launch plan?", null)[0];
  const answer = await notion.skills.answer(answerTask.params, { partial: null, report: () => {} });
  assert.equal((answer.data as { headline: string }).headline, "No matching Notion pages found.");
});

test("a matched page that fails to read is reported as an error, not as no search results", async () => {
  const page = { id: "p1", title: "Release plan", url: "https://www.notion.so/release", text: "Launch is Friday", editedAt: null };
  const [readTask] = notion.stages[0].plan([], "When is launch?", { pages: [page] });
  const failed = { skill: "read", stage: 0, params: readTask.params, output: { summary: "Failed: model unavailable", short: "Failed", data: null }, worker: "Q-02" };
  const [answerTask] = notion.stages[1].plan([failed], "When is launch?", { pages: [page] });
  const answer = await notion.skills.answer(answerTask.params, { partial: null, report: () => {} });
  assert.equal((answer.data as { headline: string }).headline, "Notion pages matched, but the Assistant could not read them.");
});

test("completed answers include linked source pages", async () => {
  const previous = process.env.SERVICES_URL;
  const originalFetch = globalThis.fetch;
  process.env.SERVICES_URL = "http://model.test";
  globalThis.fetch = async () => Response.json({ text: JSON.stringify({ headline: "The release is Friday.", answer: "The plan says launch is Friday." }) });
  try {
    const output = await notion.skills.answer({ prompt: "When is launch?", pages: [{ title: "Release plan", url: "https://www.notion.so/release", summary: "Launch is Friday.", findings: ["Owner: Alex"] }] }, { partial: null, report: () => {} });
    const result = output.data as { sections: Array<{ kind: string; items?: Array<{ title: string; url: string }> }> };
    const sources = result.sections.find((section) => section.kind === "links")?.items;
    assert.deepEqual(sources?.map(({ title, url }) => ({ title, url })), [{ title: "Release plan", url: "https://www.notion.so/release" }]);
  } finally {
    globalThis.fetch = originalFetch;
    if (previous === undefined) delete process.env.SERVICES_URL;
    else process.env.SERVICES_URL = previous;
  }
});
