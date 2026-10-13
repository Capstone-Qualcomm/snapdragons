export type Task = {
  id: string;
  input: string;
  status: "queued" | "claimed" | "done";
  worker: string | null;
  result: string | null;
};

export function createQueue() {
  const tasks: Task[] = [];
  const lastSeen = new Map<string, string>();
  let nextId = 1;

  function add(input: string): Task {
    const task: Task = { id: `T-${nextId++}`, input, status: "queued", worker: null, result: null };
    tasks.push(task);
    return task;
  }

  // Finding a queued task and marking it happen in one synchronous call, and
  // the server runs on a single thread, so two workers can never get the same task.
  // ponytail: a claim never expires, so a task is stuck if its worker dies.
  // Leases and handing the task to another worker are QT1S-9.
  function claim(worker: string): Task | null {
    lastSeen.set(worker, new Date().toISOString());
    const task = tasks.find((candidate) => candidate.status === "queued");
    if (!task) return null;
    task.status = "claimed";
    task.worker = worker;
    return task;
  }

  // Only the worker holding the claim can finish the task.
  function complete(id: string, worker: string, result: string): Task | null {
    const task = tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return null;
    task.status = "done";
    task.result = result;
    return task;
  }

  function state() {
    const workers = [...lastSeen].map(([id, seenAt]) => ({
      id,
      lastSeen: seenAt,
      current: tasks.find((task) => task.worker === id && task.status === "claimed")?.id ?? null,
      done: tasks.filter((task) => task.worker === id && task.status === "done").length,
    }));
    return { tasks, workers };
  }

  return { add, claim, complete, state };
}
