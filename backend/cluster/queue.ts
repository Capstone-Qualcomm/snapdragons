import type { Command } from "./raft.ts";

// The queue every node keeps a copy of. It only changes through apply(), which
// Raft calls with each committed command in log order, so every copy stays the
// same. Commands carry the orchestrator's clock in `at`, so applying one never reads
// this node's own clock.

// One stretch of work on a step by one node. A step that a node lost when it
// died has a "lost" run, then a new run on another node starting where it stopped.
export type Run = { worker: string; start: number; heardAt: number; end: number | null; from: number; to: number; outcome: "running" | "done" | "lost" };

export type Task = {
  id: string;
  input: string;
  status: "queued" | "claimed" | "done";
  worker: string | null;
  // Workers that held this task and went quiet before finishing it, oldest first.
  lostBy: string[];
  job: string | null;
  // Tasks that have to be done before this one can be claimed.
  after: string[];
  // The last checkpoint, from 0 to 1. A node picking up a lost step starts here.
  progress: number;
  runs: Run[];
};

export type Job = { id: string; name: string; queuedAt: number; doneAt: number | null; nodes: number | null };
export type Worker = { id: string; alive: boolean; leaving: boolean; done: number };
export type ClusterEvent = { at: number; text: string };
// When each orchestrator took over, from the empty entry it commits first.
export type Term = { term: number; orchestrator: string; at: number };
export type ClaimResult = { task: Task | null; leave?: boolean };

type Data = { nextTask: number; nextJob: number; tasks: Task[]; jobs: Job[]; workers: Worker[]; events: ClusterEvent[]; terms: Term[] };

// Old finished work is dropped past these, so an always-on cluster does not grow forever.
const KEEP_DONE = 80;
const KEEP_JOBS = 30;
const KEEP_EVENTS = 40;

const percent = (progress: number) => `${Math.round(progress * 100)}%`;

export function createQueue() {
  let data: Data = { nextTask: 1, nextJob: 1, tasks: [], jobs: [], workers: [], events: [], terms: [] };

  function log(at: number, text: string): void {
    data.events.push({ at, text });
    if (data.events.length > KEEP_EVENTS) data.events.shift();
  }

  const workerById = (id: string) => data.workers.find((worker) => worker.id === id);
  const held = (worker: string) => data.tasks.filter((task) => task.status === "claimed" && task.worker === worker);
  const currentRun = (task: Task) => task.runs.at(-1)!;

  // A step waiting on others can be claimed once they are all done. A task
  // dropped from the history was done, so a missing id counts as done.
  function ready(task: Task): boolean {
    return task.status === "queued" && task.after.every((id) => !data.tasks.some((other) => other.id === id && other.status !== "done"));
  }

  function join(worker: string, at: number): Worker {
    let entry = workerById(worker);
    if (!entry) {
      entry = { id: worker, alive: true, leaving: false, done: 0 };
      data.workers.push(entry);
      log(at, `${worker} joined`);
    } else if (!entry.alive) {
      entry.alive = true;
      log(at, `${worker} is back`);
    }
    return entry;
  }

  // The step goes back in the queue with its checkpoint, for the next node that asks.
  function release(task: Task, at: number): void {
    const run = currentRun(task);
    run.end = run.heardAt;
    run.outcome = "lost";
    task.lostBy.push(task.worker!);
    task.status = "queued";
    task.worker = null;
    log(at, `${task.id} back in the queue at ${percent(task.progress)}`);
  }

  function addJob(name: string, steps: string[], then: string | undefined, at: number): Job {
    const job: Job = { id: `J-${data.nextJob++}`, name, queuedAt: at, doneAt: null, nodes: null };
    const add = (input: string, after: string[] = []) => {
      const task: Task = { id: `T-${data.nextTask++}`, input, status: "queued", worker: null, lostBy: [], job: job.id, after, progress: 0, runs: [] };
      data.tasks.push(task);
      return task;
    };
    const fetches = steps.map((step) => add(step));
    if (then) add(then, fetches.map((task) => task.id));
    data.jobs.push(job);
    // Only finished jobs are dropped, so a long queue of unfinished ones keeps every record.
    const oldestDone = data.jobs.findIndex((old) => old.doneAt !== null);
    if (data.jobs.length > KEEP_JOBS && oldestDone !== -1) data.jobs.splice(oldestDone, 1);
    log(at, `${job.id} ${name} queued as ${steps.length + (then ? 1 : 0)} steps`);
    return job;
  }

  function claim(worker: string, at: number): ClaimResult {
    const entry = join(worker, at);
    // A node only asks for work when it is idle, so anything it still holds
    // was dropped by an earlier run of it that died.
    for (const task of held(worker)) release(task, at);
    if (entry.leaving) {
      data.workers.splice(data.workers.indexOf(entry), 1);
      log(at, `${worker} finished its work and left`);
      return { task: null, leave: true };
    }
    const task = data.tasks.find(ready);
    if (!task) return { task: null };
    task.status = "claimed";
    task.worker = worker;
    task.runs.push({ worker, start: at, heardAt: at, end: null, from: task.progress, to: task.progress, outcome: "running" });
    const from = task.lostBy.at(-1);
    log(at, from ? `${worker} resumed ${task.id} (${task.input}) at ${percent(task.progress)}, lost by ${from}` : `${worker} claimed ${task.id} (${task.input})`);
    return { task };
  }

  // A busy node reports how far it got. Returns false if the step is no longer its own.
  function progress(worker: string, id: string, value: number, at: number): boolean {
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return false;
    task.progress = Math.min(Math.max(task.progress, value), 0.99);
    const run = currentRun(task);
    run.to = task.progress;
    run.heardAt = at;
    return true;
  }

  // Only the worker holding the claim can finish the task. A worker that lost
  // its lease and comes back late gets null here, so it cannot overwrite the new owner.
  function complete(worker: string, id: string, at: number): Task | null {
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return null;
    task.status = "done";
    task.progress = 1;
    Object.assign(currentRun(task), { end: at, heardAt: at, to: 1, outcome: "done" });
    const entry = workerById(worker);
    if (entry) entry.done += 1;
    log(at, `${worker} completed ${task.id}`);

    const job = data.jobs.find((candidate) => candidate.id === task.job);
    const steps = data.tasks.filter((candidate) => candidate.job === task.job);
    if (job && steps.every((step) => step.status === "done")) {
      job.doneAt = at;
      job.nodes = new Set(steps.flatMap((step) => step.runs.filter((run) => run.outcome === "done").map((run) => run.worker))).size;
      log(at, `${job.id} done in ${((at - job.queuedAt) / 1000).toFixed(1)} s on ${job.nodes} nodes`);
    }

    const finished = data.tasks.filter((candidate) => candidate.status === "done");
    if (finished.length > KEEP_DONE) data.tasks.splice(data.tasks.indexOf(finished[0]), 1);
    return task;
  }

  // The orchestrator decided this node has been quiet too long. Its steps go back in the queue.
  function expire(worker: string, at: number): void {
    const entry = workerById(worker);
    if (!entry?.alive) return;
    entry.alive = false;
    log(at, `${worker} stopped responding`);
    for (const task of held(worker)) release(task, at);
    // It was already on its way out, so it is not coming back.
    if (entry.leaving) data.workers.splice(data.workers.indexOf(entry), 1);
  }

  // Remove: a working node finishes its step first; a dead one is dropped now.
  function leave(worker: string, at: number): void {
    const entry = workerById(worker);
    if (!entry) return;
    if (!entry.alive) {
      data.workers.splice(data.workers.indexOf(entry), 1);
      log(at, `${worker} removed`);
      return;
    }
    entry.leaving = true;
    log(at, `${worker} will leave after its current step`);
  }

  function apply(command: Command): unknown {
    const at = command.at as number;
    const worker = command.worker as string;
    switch (command.type) {
      case "noop":
        data.terms.push({ term: command.term as number, orchestrator: command.orchestrator as string, at });
        if (data.terms.length > KEEP_EVENTS) data.terms.shift();
        log(at, `${command.orchestrator} elected orchestrator for term ${command.term}`);
        return null;
      case "config":
        log(at, `Members are now ${(command.members as string[]).join(", ") || "none"}`);
        return null;
      case "job":
        return addJob(command.name as string, command.steps as string[], command.then as string | undefined, at);
      case "claim":
        return claim(worker, at);
      case "progress":
        return progress(worker, command.task as string, command.progress as number, at);
      case "complete":
        return complete(worker, command.task as string, at);
      case "expire":
        return expire(worker, at);
      case "leave":
        return leave(worker, at);
      default:
        return null;
    }
  }

  // Whether a claim from this worker would change anything. An idle node asks
  // twice a second, and most of those asks do not need to go through the log.
  function claimChangesState(worker: string): boolean {
    const entry = workerById(worker);
    return !entry || !entry.alive || entry.leaving || held(worker).length > 0 || data.tasks.some(ready);
  }

  function state() {
    const workers = data.workers.map((worker) => {
      const current = held(worker.id)[0];
      return { ...worker, current: current?.id ?? null, takenFrom: current?.lostBy.at(-1) ?? null };
    });
    // Newest first, the way the Console shows them.
    return { tasks: data.tasks, jobs: data.jobs, workers, terms: data.terms, events: [...data.events].reverse() };
  }

  return {
    apply,
    claimChangesState,
    state,
    save: () => structuredClone(data),
    load: (saved: unknown) => {
      data = structuredClone(saved as Data);
    },
  };
}

export type Queue = ReturnType<typeof createQueue>;
