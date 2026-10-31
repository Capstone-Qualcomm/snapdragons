import { boardName } from "../Cluster/cluster";
import type { ClusterState, Job, Task } from "../Cluster/cluster";

// What happened in one run, as events a person can follow: the orchestrator
// splitting a stage, a chip going out to a board, a result coming back, a board
// dying and its chip moving, a new orchestrator.

export type StoryEvent = {
  key: string;
  at: number;
  kind: "plan" | "out" | "takeover" | "back" | "lost" | "elect" | "self" | "selfdone";
  board: string | null;
  from?: string;
  task?: Task;
  text: string;
};

const quote = (text: string) => `“${text}”`;
const labelOf = (task: Task) => task.label ?? task.input;

// Newest first.
export function eventsOf(job: Job, tasks: Task[], cluster: ClusterState): StoryEvent[] {
  const events: StoryEvent[] = [];
  const plan = job.plan!;
  for (let stage = 0; stage <= plan.stage; stage++) {
    const steps = tasks.filter((task) => task.stage === stage);
    if (!steps.length) continue;
    const before = tasks.filter((task) => task.stage === stage - 1);
    const at = stage === 0 ? job.queuedAt : Math.max(job.queuedAt, ...before.map((task) => task.runs.at(-1)?.end ?? 0));
    const own = steps.every((task) => task.role === "orchestrator");
    events.push({ key: `plan-${stage}`, at, kind: "plan", board: null, text: own ? `Orchestrator took on ${plan.stages[stage].short.toLowerCase()} itself` : `Orchestrator split ${plan.stages[stage].short.toLowerCase()} into ${steps.length} tasks` });
  }
  for (const task of tasks) {
    task.runs.forEach((run, index) => {
      const board = boardName(run.worker);
      // A board that asked again while still holding its step picks it straight back up; that is not a handover.
      const again = index > 0 && task.runs[index - 1].worker === run.worker;
      const next = task.runs[index + 1];
      const resumedBySelf = next?.worker === run.worker;
      if (task.role === "orchestrator") {
        events.push({ key: `${task.id}-${index}-self`, at: run.start, kind: "self", board: run.worker, task, text: `${board}, as orchestrator, started ${quote(labelOf(task))}` });
      } else if (again) {
        // Nothing moved, so nothing to show; its result still counts below.
      } else if (index === 0) {
        events.push({ key: `${task.id}-${index}-out`, at: run.start, kind: "out", board: run.worker, task, text: `Orchestrator gave ${board} ${quote(labelOf(task))}` });
      } else {
        const from = task.runs[index - 1].worker;
        events.push({ key: `${task.id}-${index}-out`, at: run.start, kind: "takeover", board: run.worker, from, task, text: `Orchestrator gave ${boardName(from)}'s ${quote(labelOf(task))} to ${board}` });
      }
      // The moment the orchestrator noticed the board had stopped answering and took its step back.
      if (run.outcome === "lost" && !resumedBySelf) events.push({ key: `${task.id}-${index}-lost`, at: run.lostAt ?? run.end ?? run.heardAt, kind: "lost", board: run.worker, task, text: `Orchestrator noticed ${board} stopped responding and took back ${quote(labelOf(task))}` });
      if (run.outcome === "done") events.push({ key: `${task.id}-${index}-back`, at: run.end!, kind: task.role === "orchestrator" ? "selfdone" : "back", board: run.worker, task, text: `${board} sent back ${quote(task.output?.short ?? "done")}` });
    });
  }
  for (const term of cluster.terms) {
    if (term.at > job.queuedAt && (job.doneAt === null || term.at <= job.doneAt)) events.push({ key: `term-${term.term}`, at: term.at, kind: "elect", board: term.orchestrator, text: `${boardName(term.orchestrator)} became the orchestrator` });
  }
  return events.sort((a, b) => b.at - a.at);
}

const names = (ids: string[]) => {
  const numbers = ids.map((id) => boardName(id).replace("Board ", ""));
  // Simulated boards are numbers ("Boards 1, 2 and 4"); real ones are their owners' names ("Sanyam, Matt and Alex").
  const named = numbers.some((name) => !/^\d+$/.test(name));
  const list = numbers.length === 1 ? numbers[0] : `${numbers.slice(0, -1).join(", ")} and ${numbers.at(-1)}`;
  return named ? list : numbers.length === 1 ? `Board ${list}` : `Boards ${list}`;
};

// One line, 6–10 words, saying what is happening right now.
export function narrate(job: Job, tasks: Task[], cluster: ClusterState, events: StoryEvent[], now: number): string {
  const plan = job.plan!;
  if (job.doneAt !== null) return plan.error ? "Stopped before it finished" : `Done in ${((job.doneAt - job.queuedAt) / 1000).toFixed(0)} s on ${job.nodes} boards`;
  if (!cluster.orchestrator) return "Orchestrator died. Boards are electing a new one…";
  const recent = events.filter((event) => now - event.at < 3500);
  const first = (kind: StoryEvent["kind"]) => recent.find((event) => event.kind === kind);
  const takeover = first("takeover");
  if (takeover) return `Orchestrator gave ${boardName(takeover.from!)}'s ${labelOf(takeover.task!)} to ${boardName(takeover.board!)}`;
  const lost = first("lost");
  if (lost) return `Orchestrator noticed ${boardName(lost.board!)} stopped responding`;
  // Down, but the orchestrator has not noticed yet: it still counts the step as that board's.
  const silent = tasks.find((task) => task.status === "claimed" && cluster.nodes.some((node) => node.id === task.worker && !node.up));
  if (silent) return `${boardName(silent.worker!)} went down holding ${labelOf(silent)}`;
  const elect = first("elect");
  if (elect) return `${boardName(elect.board!)} is the new orchestrator and picks up the plan`;
  const planned = first("plan");
  if (planned) return planned.text;
  const back = first("back");
  if (back) return `${boardName(back.board!)} sent back ${back.task!.output?.short ?? "a result"}`;

  const stageTasks = tasks.filter((task) => task.stage === plan.stage);
  const own = stageTasks.find((task) => task.role === "orchestrator");
  if (own) return `Orchestrator is putting it together: ${labelOf(own).toLowerCase()}`;
  const working = [...new Set(stageTasks.filter((task) => task.status === "claimed").map((task) => task.worker!))].sort();
  if (!working.length) return `Waiting for a free board for ${plan.stages[plan.stage].short.toLowerCase()}`;
  return `${names(working)} on ${plan.stages[plan.stage].short.toLowerCase()}`;
}

// "Read" becomes "Reading", for a card's caption.
export function ing(verb: string): string {
  const base = verb.toLowerCase().replace(/ed$/, "").replace(/^read$/, "read");
  if (base === "read") return "Reading";
  const word = base.endsWith("e") ? `${base.slice(0, -1)}ing` : `${base}ing`;
  return word[0].toUpperCase() + word.slice(1);
}

// "Reading emails · 23/40", or "Working · 40%" for a step without a count.
export function caption(task: Task): string {
  const meter = task.meter;
  if (!meter) return `Working · ${Math.round(task.progress * 100)}%`;
  const count = Math.min(meter.total, Math.floor(task.progress * meter.total));
  return `${ing(meter.verb)} ${meter.noun} · ${count}/${meter.total}`;
}
