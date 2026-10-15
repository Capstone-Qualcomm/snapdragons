export type Task = {
  id: string;
  input: string;
  status: "queued" | "claimed" | "done";
  worker: string | null;
  result: string | null;
  // Workers that held this task and went quiet before finishing it, oldest first.
  lostBy: string[];
};

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
  let nextId = 1;

  function add(input: string): Task {
    const task: Task = { id: `T-${nextId++}`, input, status: "queued", worker: null, result: null, lostBy: [] };
    tasks.push(task);
    return task;
  }

  // A worker that has been quiet for longer than the lease has stopped, so its
  // task goes back in the queue for the next worker that asks. claim() and
  // state() call this first, so no timer is needed.
  function requeueExpired(): void {
    for (const task of tasks) {
      if (task.status !== "claimed" || !task.worker) continue;
      if (now() - (lastSeen.get(task.worker) ?? 0) <= leaseMs) continue;
      release(task);
    }
  }

  function release(task: Task): void {
    if (task.worker) task.lostBy.push(task.worker);
    task.status = "queued";
    task.worker = null;
  }

  // A busy worker calls this every second so the queue knows it has not died.
  // Leases are checked first, so a late heartbeat cannot revive an expired claim.
  function heartbeat(worker: string): void {
    requeueExpired();
    lastSeen.set(worker, now());
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
    lastSeen.set(worker, now());
    const task = tasks.find((candidate) => candidate.status === "queued");
    if (!task) return null;
    task.status = "claimed";
    task.worker = worker;
    return task;
  }

  // Only the worker holding the claim can finish the task. A worker that lost
  // its lease and comes back late gets null here, so it cannot overwrite the new owner.
  function complete(id: string, worker: string, result: string): Task | null {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return null;
    task.status = "done";
    task.result = result;
    return task;
  }

  function state() {
    requeueExpired();
    const workers = [...lastSeen].map(([id, seenAt]) => {
      const current = tasks.find((task) => task.worker === id && task.status === "claimed");
      return {
        id,
        lastSeen: new Date(seenAt).toISOString(),
        current: current?.id ?? null,
        // The worker this one picked the current task up from, if it was handed over.
        takenFrom: current?.lostBy.at(-1) ?? null,
        done: tasks.filter((task) => task.worker === id && task.status === "done").length,
      };
    });
    return { tasks, workers };
  }

  return { add, claim, heartbeat, complete, state };
}
