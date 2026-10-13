import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "./queue.ts";

test("each task is claimed by one worker only", () => {
  const queue = createQueue();
  queue.add("a");
  queue.add("b");

  assert.equal(queue.claim("Q-01")?.id, "T-1");
  assert.equal(queue.claim("Q-02")?.id, "T-2");
  assert.equal(queue.claim("Q-03"), null);
});

test("only the claiming worker can complete a task", () => {
  const queue = createQueue();
  const task = queue.add("a");
  queue.claim("Q-01");

  assert.equal(queue.complete(task.id, "Q-02", "stolen"), null);
  assert.equal(queue.complete(task.id, "Q-01", "ok")?.status, "done");
  assert.equal(queue.complete(task.id, "Q-01", "twice"), null);
});

test("state reports what each worker holds and has finished", () => {
  const queue = createQueue();
  queue.add("a");
  queue.add("b");
  queue.claim("Q-01");
  queue.complete("T-1", "Q-01", "ok");
  queue.claim("Q-01");
  queue.claim("Q-02");

  const workers = queue.state().workers.map(({ id, current, done }) => ({ id, current, done }));
  assert.deepEqual(workers, [
    { id: "Q-01", current: "T-2", done: 1 },
    { id: "Q-02", current: null, done: 0 },
  ]);
});
