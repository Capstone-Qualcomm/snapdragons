import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "./queue.ts";
import type { ClaimResult, Job, Task } from "./queue.ts";

// The queue only changes through commands, the way Raft feeds it. These helpers
// send one command each, with a clock the test sets.
function testQueue() {
  const queue = createQueue();
  let at = 0;
  const run = (type: string, fields: Record<string, unknown> = {}) => queue.apply({ type, at, ...fields });
  return {
    queue,
    tick: (ms: number) => (at += ms),
    job: (steps: string[], then?: string) => run("job", { name: "Morning refresh", steps, then }) as Job,
    claim: (worker: string) => (run("claim", { worker }) as ClaimResult).task?.id ?? null,
    claimed: (worker: string) => (run("claim", { worker }) as ClaimResult),
    progress: (worker: string, task: string, progress: number) => run("progress", { worker, task, progress }) as boolean,
    complete: (worker: string, task: string) => run("complete", { worker, task }) as Task | null,
    expire: (worker: string) => run("expire", { worker }),
    leave: (worker: string) => run("leave", { worker }),
    task: (id: string) => queue.state().tasks.find((task) => task.id === id)!,
  };
}

test("each step is claimed by one worker only", () => {
  const q = testQueue();
  q.job(["a", "b"]);

  assert.equal(q.claim("Q-01"), "T-1");
  assert.equal(q.claim("Q-02"), "T-2");
  assert.equal(q.claim("Q-03"), null);
});

test("only the claiming worker can complete a step", () => {
  const q = testQueue();
  q.job(["a"]);
  q.claim("Q-01");

  assert.equal(q.complete("Q-02", "T-1"), null);
  assert.equal(q.complete("Q-01", "T-1")?.status, "done");
  assert.equal(q.complete("Q-01", "T-1"), null);
});

test("the last step waits until the others are done", () => {
  const q = testQueue();
  q.job(["Fetch Jira", "Fetch Slack"], "Rank");

  assert.equal(q.claim("Q-01"), "T-1");
  assert.equal(q.claim("Q-02"), "T-2");
  assert.equal(q.claim("Q-03"), null);
  q.complete("Q-01", "T-1");
  assert.equal(q.claim("Q-03"), null);
  q.complete("Q-02", "T-2");
  assert.equal(q.claim("Q-03"), "T-3");
});

test("a step lost by a dead worker resumes from its last checkpoint on another", () => {
  const q = testQueue();
  q.job(["a"]);
  q.claim("Q-01");
  q.tick(1000);
  q.progress("Q-01", "T-1", 0.4);
  q.tick(2000);
  q.expire("Q-01");

  const { task } = q.claimed("Q-02");
  assert.equal(task?.progress, 0.4);
  assert.deepEqual(task?.lostBy, ["Q-01"]);
  // The lost run ends at the last time Q-01 was heard from, and the new one starts at 40%.
  assert.deepEqual(task?.runs.map(({ worker, start, end, from, to, outcome }) => ({ worker, start, end, from, to, outcome })), [
    { worker: "Q-01", start: 0, end: 1000, from: 0, to: 0.4, outcome: "lost" },
    { worker: "Q-02", start: 3000, end: null, from: 0.4, to: 0.4, outcome: "running" },
  ]);
  assert.equal(q.progress("Q-01", "T-1", 0.9), false);
  assert.equal(q.complete("Q-01", "T-1"), null);
  assert.equal(q.complete("Q-02", "T-1")?.status, "done");
});

test("a worker that restarts under the same name gives up the step it held", () => {
  const q = testQueue();
  q.job(["a", "b"]);
  q.claim("Q-02");

  // Q-02 died and came back before anyone noticed, so it asks for work while still holding T-1.
  assert.equal(q.claim("Q-02"), "T-1");
  assert.deepEqual(q.task("T-1").lostBy, ["Q-02"]);
  assert.equal(q.claim("Q-01"), "T-2");
});

test("a removed worker finishes its step, then is told to leave", () => {
  const q = testQueue();
  q.job(["a", "b"]);
  q.claim("Q-01");
  q.leave("Q-01");

  assert.equal(q.queue.state().workers[0].leaving, true);
  assert.equal(q.complete("Q-01", "T-1")?.status, "done");
  assert.deepEqual(q.claimed("Q-01"), { task: null, leave: true });
  assert.deepEqual(q.queue.state().workers, []);
  assert.equal(q.task("T-2").status, "queued");
});

test("a finished job records how long it took and how many nodes ran it", () => {
  const q = testQueue();
  const job = q.job(["a", "b"], "c");
  q.claim("Q-01");
  q.claim("Q-02");
  q.tick(3000);
  q.complete("Q-01", "T-1");
  q.complete("Q-02", "T-2");
  q.claim("Q-02");
  q.tick(3000);
  q.complete("Q-02", "T-3");

  assert.deepEqual(q.queue.state().jobs.find((entry) => entry.id === job.id), { id: "J-1", name: "Morning refresh", queuedAt: 0, doneAt: 6000, nodes: 2 });
});

test("old done tasks and events are dropped, done counts are kept", () => {
  const q = testQueue();
  for (let n = 1; n <= 100; n++) {
    q.job([`step ${n}`]);
    q.complete("Q-01", q.claim("Q-01")!);
  }

  const { tasks, workers, events, jobs } = q.queue.state();
  assert.equal(tasks.length, 80);
  assert.equal(jobs.length, 30);
  assert.equal(workers[0].done, 100);
  assert.equal(events.length, 40);
  assert.match(events[0].text, /^J-100 done/);
});

test("unfinished jobs are kept however many are queued", () => {
  const q = testQueue();
  for (let n = 1; n <= 35; n++) q.job([`step ${n}`]);

  assert.deepEqual(q.queue.state().jobs.map((job) => job.id), Array.from({ length: 35 }, (_, n) => `J-${n + 1}`));
});

test("a saved copy loads into another queue unchanged", () => {
  const q = testQueue();
  q.job(["a", "b"]);
  q.claim("Q-01");
  const copy = createQueue();
  copy.load(q.queue.save());

  assert.deepEqual(copy.state(), q.queue.state());
});
