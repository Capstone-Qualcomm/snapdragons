import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "./queue.ts";
import type { Job } from "./queue.ts";
import { chunksOf } from "./scenarios/mywork.ts";

const item = (source: string, id: string) => ({ source, id, title: `${id} title`, context: "", details: "" });

test("each app's items go to their own board, and a big app is split", () => {
  const items = [item("jira", "QT1S-1"), item("slack", "m1"), ...Array.from({ length: 65 }, (_, n) => item("github", `#${n}`))];
  assert.deepEqual(chunksOf(items).map((chunk) => [chunk.label, chunk.items.length]), [["Jira", 1], ["Slack", 1], ["GitHub 1", 30], ["GitHub 2", 30], ["GitHub 3", 5]]);
  assert.equal(chunksOf([]).length, 0);
});

test("a question about your work becomes one read step per app, and the items are not kept on the job", () => {
  const queue = createQueue();
  queue.apply({ type: "noop", at: 10, term: 1, orchestrator: "Q-01" });
  const context = [item("jira", "QT1S-1"), item("slack", "m1"), item("github", "#7")];
  const job = queue.apply({ type: "plan", at: 20, scenario: "mywork", prompt: "What do I need to do today?", pace: 1, context }) as Job;
  const reads = queue.state().tasks.filter((task) => task.job === job.id && task.skill === "read");
  assert.deepEqual(reads.map((task) => (task.params as { label: string }).label).sort(), ["GitHub", "Jira", "Slack"]);
  assert.equal(JSON.stringify(queue.state().jobs).includes("QT1S-1 title"), false);
});
