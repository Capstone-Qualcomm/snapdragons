import type { Found, Icon, Json, Meter, Preview, StepOutput } from "./plan.ts";
import type { Command } from "./raft.ts";
import { scenarioById } from "./scenarios/index.ts";

// The queue every node keeps a copy of. It only changes through apply(), which
// Raft calls with each committed command in log order, so every copy stays the
// same. Commands carry the orchestrator's clock in `at`, so applying one never reads
// this node's own clock.

// One stretch of work on a step by one node. A step that a node lost when it
// died has a "lost" run, then a new run on another node starting where it stopped.
// lostAt is when the orchestrator noticed the board had stopped responding and took the step back.
export type Run = { worker: string; start: number; heardAt: number; end: number | null; from: number; to: number; outcome: "running" | "done" | "lost"; lostAt?: number };

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
  // Steps of an Assistant plan also carry what to do and what came of it.
  // input is then the plain-English instruction the board was given.
  skill?: string;
  label?: string;
  icon?: Icon;
  // Its real input in small, and what it has found, for the page to draw.
  preview?: Preview;
  found?: Found | null;
  scenario?: string;
  params?: Json;
  output?: StepOutput | null;
  stage?: number;
  durationMs?: number;
  meter?: Meter;
  // The board the orchestrator handed it to. Anyone may take it once that board is down or busy.
  assignee?: string | null;
  // Planning and merging steps only the current orchestrator runs.
  role?: "orchestrator";
};

export type Plan = { scenario: string; prompt: string; pace: number; stage: number; stages: Array<{ label: string; short: string; icon: Icon }>; result: Json | null; error?: string };
export type Job = { id: string; name: string; queuedAt: number; doneAt: number | null; nodes: number | null; plan?: Plan };
export type Worker = { id: string; alive: boolean; leaving: boolean; done: number };
export type ClusterEvent = { at: number; text: string };
// When each orchestrator took over, from the empty entry it commits first.
export type Term = { term: number; orchestrator: string; at: number };
export type ClaimResult = { task: Task | null; leave?: boolean };

type Data = { nextTask: number; nextJob: number; tasks: Task[]; jobs: Job[]; workers: Worker[]; events: ClusterEvent[]; terms: Term[] };

// Old finished work is dropped past these, so an always-on cluster does not grow forever.
// The last two plans and their steps are kept, so their results stay on screen.
const KEEP_DONE = 80;
const KEEP_JOBS = 30;
const KEEP_EVENTS = 60;
const KEEP_PLANS = 2;

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

  // The orchestrator as of the last election this queue saw, so every copy agrees on it.
  const orchestrator = () => data.terms.at(-1)?.orchestrator ?? null;
  // Boards that can be handed a plan step: up, staying, and not the orchestrator.
  const available = (id: string) => {
    const entry = workerById(id);
    return !!entry && entry.alive && !entry.leaving && id !== orchestrator();
  };
  const workersFor = () => data.workers.filter((worker) => available(worker.id)).map((worker) => worker.id);

  // The orchestrator plans and merges; the other boards do the plan's steps.
  // With no other board up, the orchestrator does them itself so the plan still finishes.
  function may(worker: string, task: Task): boolean {
    if (task.role === "orchestrator") return worker === orchestrator();
    if (task.skill && worker === orchestrator()) return workersFor().length === 0;
    return true;
  }

  // Its own step first, then one nobody can take, then one waiting on a board that is busy.
  function pick(worker: string): Task | undefined {
    const open = data.tasks.filter((task) => ready(task) && may(worker, task));
    return (
      open.find((task) => task.assignee === worker) ??
      open.find((task) => !task.assignee || !available(task.assignee)) ??
      open.find((task) => held(task.assignee!).length > 0)
    );
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
    run.lostAt = at;
    task.lostBy.push(task.worker!);
    task.status = "queued";
    task.worker = null;
    if (task.assignee) task.assignee = null;
    log(at, `${task.id} back in the queue at ${percent(task.progress)}, from ${task.lostBy.at(-1)}`);
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
    trimJobs();
    log(at, `${job.id} ${name} queued as ${steps.length + (then ? 1 : 0)} steps`);
    return job;
  }

  // An Assistant plan: the scenario's first stage is queued now, and each next
  // stage is planned from the outputs of the one before when its last step is done.
  function addPlan(id: string, prompt: string, pace: number, at: number): Job {
    const scenario = scenarioById(id);
    if (!scenario) throw new Error(`No scenario ${id}.`);
    const job: Job = { id: `J-${data.nextJob++}`, name: scenario.title, queuedAt: at, doneAt: null, nodes: null, plan: { scenario: id, prompt, pace, stage: -1, stages: scenario.stages.map(({ label, short, icon }) => ({ label, short, icon })), result: null } };
    data.jobs.push(job);
    log(at, `${orchestrator() ?? "The orchestrator"} got a job: "${prompt}"`);
    startStage(job, 0, at);
    trimJobs();
    return job;
  }

  function doneSteps(job: Job) {
    return data.tasks
      .filter((task) => task.job === job.id && task.status === "done" && task.output)
      .map((task) => ({ skill: task.skill!, stage: task.stage!, params: task.params ?? null, output: task.output!, worker: task.runs.at(-1)!.worker }));
  }

  function startStage(job: Job, stage: number, at: number): void {
    const plan = job.plan!;
    const scenario = scenarioById(plan.scenario)!;
    if (stage >= scenario.stages.length) return finishPlan(job, at);
    let specs;
    try {
      specs = scenario.stages[stage].plan(doneSteps(job));
    } catch (cause) {
      plan.error = `Stage ${stage + 1} could not be planned: ${(cause as Error).message}`;
      return finishPlan(job, at);
    }
    plan.stage = stage;
    if (!specs.length) return startStage(job, stage + 1, at);

    // Hand each step to a board: the ones that ran the last stage, or the ones that did not, as the step asks.
    const pool = workersFor();
    const previous = [...new Set(data.tasks.filter((task) => task.job === job.id && task.stage === stage - 1 && task.status === "done").map((task) => task.runs.at(-1)!.worker))].filter((id) => pool.includes(id));
    const fresh = pool.filter((id) => !previous.includes(id));
    const load = new Map<string, number>();
    for (const spec of specs) {
      const order = spec.assign === "previous" ? [...previous, ...fresh] : spec.assign === "fresh" ? [...fresh, ...previous] : pool;
      let assignee: string | null = null;
      if (spec.role !== "orchestrator") {
        for (const id of order) if (assignee === null || (load.get(id) ?? 0) < (load.get(assignee) ?? 0)) assignee = id;
        if (assignee) load.set(assignee, (load.get(assignee) ?? 0) + 1);
      }
      data.tasks.push({
        id: `T-${data.nextTask++}`,
        input: spec.instruction,
        status: "queued",
        worker: null,
        lostBy: [],
        job: job.id,
        after: [],
        progress: 0,
        runs: [],
        skill: spec.skill,
        label: spec.label,
        icon: spec.icon,
        ...(spec.preview && { preview: spec.preview }),
        scenario: plan.scenario,
        params: spec.params,
        output: null,
        stage,
        durationMs: Math.round(spec.ms * plan.pace),
        ...(spec.meter && { meter: spec.meter }),
        assignee,
        ...(spec.role && { role: spec.role }),
      });
    }
    log(at, `${orchestrator() ?? "The orchestrator"} planned step ${stage + 1} of ${scenario.stages.length}, ${scenario.stages[stage].label.toLowerCase()}: ${specs.length} ${specs.length === 1 ? "task" : "tasks"}`);
  }

  function finishPlan(job: Job, at: number): void {
    const steps = data.tasks.filter((task) => task.job === job.id);
    const last = steps.filter((task) => task.stage === job.plan!.stage && task.output).at(-1);
    job.plan!.result = last?.output?.data ?? null;
    job.doneAt = at;
    job.nodes = new Set(steps.flatMap((step) => step.runs.filter((run) => run.outcome === "done").map((run) => run.worker))).size;
    log(at, `Plan ${job.id} done in ${((at - job.queuedAt) / 1000).toFixed(1)} s on ${job.nodes} nodes`);
  }

  // Stop: the plan's unfinished steps are dropped, so a board still on one finds it gone when it reports.
  function cancel(id: string, at: number): Job | null {
    const job = data.jobs.find((entry) => entry.id === id);
    if (!job?.plan || job.doneAt !== null) return null;
    data.tasks = data.tasks.filter((task) => task.job !== id || task.status === "done");
    job.plan.error = "Stopped before it finished.";
    job.doneAt = at;
    log(at, `Plan ${job.id} stopped`);
    return job;
  }

  // Finished refreshes go first; the last plans stay so their results can still be read.
  function trimJobs(): void {
    const plans = data.jobs.filter((job) => job.plan).slice(-KEEP_PLANS).map((job) => job.id);
    const oldestDone = data.jobs.findIndex((old) => old.doneAt !== null && !plans.includes(old.id));
    if (data.jobs.length > KEEP_JOBS && oldestDone !== -1) data.jobs.splice(oldestDone, 1);
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
    const task = pick(worker);
    if (!task) return { task: null };
    task.status = "claimed";
    task.worker = worker;
    task.runs.push({ worker, start: at, heardAt: at, end: null, from: task.progress, to: task.progress, outcome: "running" });
    const from = task.lostBy.at(-1);
    log(at, from ? `${worker} resumed ${task.id} (${task.input}) at ${percent(task.progress)}, lost by ${from}` : `${worker} claimed ${task.id} (${task.input})`);
    return { task };
  }

  // A busy node reports how far it got. Returns false if the step is no longer its own.
  function progress(worker: string, id: string, value: number, at: number, found?: Found): boolean {
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return false;
    if (found && !task.found) task.found = found;
    task.progress = Math.min(Math.max(task.progress, value), 0.99);
    const run = currentRun(task);
    run.to = task.progress;
    run.heardAt = at;
    return true;
  }

  // Only the worker holding the claim can finish the task. A worker that lost
  // its lease and comes back late gets null here, so it cannot overwrite the new owner.
  function complete(worker: string, id: string, at: number, output?: StepOutput): Task | null {
    const task = data.tasks.find((candidate) => candidate.id === id);
    if (!task || task.status !== "claimed" || task.worker !== worker) return null;
    task.status = "done";
    task.progress = 1;
    if (task.skill) task.output = output ?? { summary: "Finished without a result", short: "Done", data: null };
    Object.assign(currentRun(task), { end: at, heardAt: at, to: 1, outcome: "done" });
    const entry = workerById(worker);
    if (entry) entry.done += 1;
    log(at, `${worker} completed ${task.id}`);

    const job = data.jobs.find((candidate) => candidate.id === task.job);
    const steps = data.tasks.filter((candidate) => candidate.job === task.job);
    if (job?.plan) {
      // The stage is done when its last step is; the orchestrator then plans the next from what came back.
      if (steps.every((step) => step.status === "done")) startStage(job, job.plan.stage + 1, at);
    } else if (job && steps.every((step) => step.status === "done")) {
      job.doneAt = at;
      job.nodes = new Set(steps.flatMap((step) => step.runs.filter((run) => run.outcome === "done").map((run) => run.worker))).size;
      log(at, `${job.id} done in ${((at - job.queuedAt) / 1000).toFixed(1)} s on ${job.nodes} nodes`);
    }

    // A running plan's later stages read its earlier steps' outputs, so those are never dropped.
    const plans = data.jobs.filter((entry) => entry.plan);
    const kept = new Set([...plans.slice(-KEEP_PLANS), ...plans.filter((entry) => entry.doneAt === null)].map((entry) => entry.id));
    const finished = data.tasks.filter((candidate) => candidate.status === "done" && !kept.has(candidate.job ?? ""));
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
  // Returns false when no other node would be left working. Removals go through
  // the log one at a time, so two at once cannot both take the last two nodes.
  function leave(worker: string, at: number): boolean {
    const entry = workerById(worker);
    if (!entry) return true;
    if (!entry.alive) {
      data.workers.splice(data.workers.indexOf(entry), 1);
      log(at, `${worker} removed`);
      return true;
    }
    if (entry.leaving) return true;
    if (!data.workers.some((other) => other !== entry && other.alive && !other.leaving)) return false;
    entry.leaving = true;
    log(at, `${worker} will leave after its current step`);
    return true;
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
      case "cancel":
        return cancel(command.job as string, at);
      case "plan":
        return addPlan(command.scenario as string, command.prompt as string, (command.pace as number) || 1, at);
      case "claim":
        return claim(worker, at);
      case "progress":
        return progress(worker, command.task as string, command.progress as number, at, command.found as Found | undefined);
      case "complete":
        return complete(worker, command.task as string, at, command.output as StepOutput | undefined);
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
    return !entry || !entry.alive || entry.leaving || held(worker).length > 0 || pick(worker) !== undefined;
  }

  function state() {
    const workers = data.workers.map((worker) => {
      const current = held(worker.id)[0];
      return { ...worker, current: current?.id ?? null, takenFrom: current?.lostBy.at(-1) ?? null };
    });
    // Newest first, the way the Cluster view shows them.
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
