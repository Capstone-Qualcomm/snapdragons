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

// A clock the test moves by hand, so a two second lease takes no real time.
function fakeClock() {
  let time = 0;
  return { now: () => time, advance: (ms: number) => (time += ms) };
}

test("a task goes back in the queue when its worker stops heartbeating", () => {
  const clock = fakeClock();
  const queue = createQueue({ leaseMs: 2000, now: clock.now });
  queue.add("a");
  queue.claim("Q-01");

  clock.advance(2001);
  const task = queue.claim("Q-02");

  assert.equal(task?.id, "T-1");
  assert.equal(task?.worker, "Q-02");
  assert.deepEqual(task?.lostBy, ["Q-01"]);
});

test("heartbeats keep a slow worker's task from being handed out", () => {
  const clock = fakeClock();
  const queue = createQueue({ leaseMs: 2000, now: clock.now });
  queue.add("a");
  queue.claim("Q-01");

  for (let second = 0; second < 5; second++) {
    clock.advance(1000);
    queue.heartbeat("Q-01");
  }

  assert.equal(queue.claim("Q-02"), null);
  assert.equal(queue.complete("T-1", "Q-01", "ok")?.status, "done");
});

test("a worker that lost its task cannot finish it late", () => {
  const clock = fakeClock();
  const queue = createQueue({ leaseMs: 2000, now: clock.now });
  queue.add("a");
  queue.claim("Q-01");
  clock.advance(2001);
  queue.claim("Q-02");

  assert.equal(queue.complete("T-1", "Q-01", "late"), null);
  assert.equal(queue.complete("T-1", "Q-02", "ok")?.result, "ok");
});

test("state shows who a handed-over task was taken from", () => {
  const clock = fakeClock();
  const queue = createQueue({ leaseMs: 2000, now: clock.now });
  queue.add("a");
  queue.claim("Q-01");
  clock.advance(2001);
  queue.claim("Q-02");

  const workers = queue.state().workers.map(({ id, current, takenFrom }) => ({ id, current, takenFrom }));
  assert.deepEqual(workers, [
    { id: "Q-01", current: null, takenFrom: null },
    { id: "Q-02", current: "T-1", takenFrom: "Q-01" },
  ]);
});

test("a worker that restarts under the same name does not keep its old task stuck", () => {
  const clock = fakeClock();
  const queue = createQueue({ leaseMs: 2000, now: clock.now });
  queue.add("a");
  queue.add("b");
  queue.claim("Q-02");

  // Q-02 dies, then a new Q-02 starts and asks for work before anyone else does.
  clock.advance(2001);
  const task = queue.claim("Q-02");

  assert.equal(task?.id, "T-1");
  assert.deepEqual(task?.lostBy, ["Q-02"]);
  assert.equal(queue.claim("Q-01")?.id, "T-2");
});

test("a worker asking for work again gives up the task it was holding", () => {
  const queue = createQueue();
  queue.add("a");
  queue.add("b");
  queue.claim("Q-02");
  queue.claim("Q-02");

  const held = queue.state().tasks.filter((task) => task.status === "claimed");
  assert.deepEqual(held.map((task) => task.id), ["T-1"]);
});
