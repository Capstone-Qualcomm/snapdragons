export type Task = {
  id: string;
  input: string;
  status: "queued" | "claimed" | "done";
  worker: string | null;
  result: string | null;
  // Workers that held this task and went quiet before finishing it, oldest first.
  lostBy: string[];
  // The job this task is a step of, if it was queued as part of one.
  job: { id: string; name: string } | null;
  // Tasks that have to be done before this one can be claimed.
  after: string[];
};

export type ClusterEvent = { at: string; text: string };

// Old finished tasks and events are dropped past these, so a long-running demo does not grow forever.
const KEEP_DONE = 50;
const KEEP_EVENTS = 40;

type QueueOptions = {
  // How long a worker can go without being heard from before its task is handed to someone else.
  leaseMs?: number;
  // Tests pass a fake clock so they can skip ahead without waiting.
  now?: () => number;
};

export function createQueue({ leaseMs = 2000, now = Date.now }: QueueOptions = {}) {
  const tasks: Task[] = [];
  // When each worker last talked to the queue (a claim or a heartbeat), in milliseconds.
  const lastSeen = new Map<string, number>();
  // Workers whose lease ran out and who have not been heard from since.
  const gone = new Set<string>();
  // Kept apart from the tasks so the counts survive old tasks being dropped.
  const doneBy = new Map<string, number>();
  const events: ClusterEvent[] = [];
  let nextId = 1;

  function add(input: string, job: Task["job"] = null, after: string[] = []): Task {
    const task: Task = { id: `T-${nextId++}`, input, status: "queued", worker: null, result: null, lostBy: [], job, after };
    tasks.push(task);
    return task;
  }

  function log(text: string): void {
    events.push({ at: new Date(now()).toISOString(), text });
    if (events.length > KEEP_EVENTS) events.shift();
  }

  function seen(worker: string): void {
    if (!lastSeen.has(worker) || gone.delete(worker)) log(`${worker} joined`);
    lastSeen.set(worker, now());
  }

  function pending(): number {
    return tasks.filter((task) => task.status !== "done").length;
  }

  // A worker that has been quiet for longer than the lease has stopped, so its
  // task goes back in the queue for the next worker that asks. claim() and
  // state() call this first, so no timer is needed.
  function requeueExpired(): void {
    for (const [worker, seenAt] of lastSeen) {
      if (gone.has(worker) || now() - seenAt <= leaseMs) continue;
      gone.add(worker);
      log(`${worker} stopped responding`);
    }
    for (const task of tasks) {
      if (task.status === "claimed" && task.worker && gone.has(task.worker)) release(task);
    }
  }

  function release(task: Task): void {
    if (task.worker) task.lostBy.push(task.worker);
    task.status = "queued";
    task.worker = null;
    log(`${task.id} back in the queue`);
  }

  // A step waiting on others can be claimed once they are all done. A task
  // dropped from the history was done, so a missing id counts as done.
  function ready(task: Task): boolean {
    return task.status === "queued" && task.after.every((id) => !tasks.some((other) => other.id === id && other.status !== "done"));
  }

  // A busy worker calls this every second so the queue knows it has not died.
  // Leases are checked first, so a late heartbeat cannot revive an expired claim.
  function heartbeat(worker: string): void {
    requeueExpired();
    seen(worker);
  }

  // Finding a queued task and marking it happen in one synchronous call, and
  // the server runs on a single thread, so two workers can never get the same task.
  function claim(worker: string): Task | null {
    // Leases are checked before this claim counts as a sign of life, or a worker
    // that died and restarted under the same name would revive its old task.
    requeueExpired();
    // A worker only asks for work when it is idle, so anything it still holds
    // was dropped by an earlier run of it that died.
    for (const task of tasks) {
      if (task.status === "claimed" && task.worker === worker) release(task);
    }
    seen(worker);
    const task = tasks.find(ready);
    if (!task) return null;
    task.status = "claimed";
    task.worker = worker;
    const from = task.lostBy.at(-1);
    log(from ? `${worker} took over ${task.id} (${task.input}) from ${from}` : `${worker} claimed ${task.id} (${task.input})`);
    return task;
  }

  // Only the worker holding the claim can finish the task. A worker that lost
  // its lease and comes back late gets null here, so it cannot overwrite the new owner.
  function complete(id: string, worker: string, result: string): Task | null {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return null;
    task.status = "done";
    task.result = result;
    doneBy.set(worker, (doneBy.get(worker) ?? 0) + 1);
    log(`${worker} completed ${task.id}`);
    const finished = tasks.filter((candidate) => candidate.status === "done");
    if (finished.length > KEEP_DONE) tasks.splice(tasks.indexOf(finished[0]), 1);
    return task;
  }

  function state() {
    requeueExpired();
    const workers = [...lastSeen].map(([id, seenAt]) => {
      const current = tasks.find((task) => task.worker === id && task.status === "claimed");
      return {
        id,
        lastSeen: new Date(seenAt).toISOString(),
        alive: !gone.has(id),
        current: current?.id ?? null,
        // The worker this one picked the current task up from, if it was handed over.
        takenFrom: current?.lostBy.at(-1) ?? null,
        done: doneBy.get(id) ?? 0,
      };
    });
    // Newest first, the way the Console shows them.
    return { tasks, workers, events: [...events].reverse() };
  }

  return { add, claim, heartbeat, complete, state, log, pending };
}
