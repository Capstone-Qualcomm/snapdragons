import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../../lib/urls";

// The shape of GET /api/cluster/state, from backend/cluster/server.ts.

export type Run = { worker: string; start: number; heardAt: number; end: number | null; from: number; to: number; outcome: "running" | "done" | "lost"; lostAt?: number };
export type Meter = { verb: string; noun: string; total: number };
export type Preview =
  | { kind: "list"; look: string; rows: Array<[string, string]> }
  | { kind: "page"; look: string; pages: Array<{ url: string; lines: string[] }> }
  | { kind: "calendar"; days: string[]; busy: Array<[number, number, number]> };
export type Found = { marks?: Array<[number, string]>; chips?: string[]; pages?: string[][]; slots?: Array<[number, number, number]> };
export type StepOutput = { summary: string; short: string; data: unknown; found?: Found };
export type Task = {
  id: string;
  input: string;
  status: "queued" | "claimed" | "done";
  worker: string | null;
  lostBy: string[];
  job: string | null;
  after: string[];
  progress: number;
  runs: Run[];
  // Assistant plan steps: input is then the board's plain-English instruction.
  skill?: string;
  // The 2–4 words and the icon drawn on its chip.
  label?: string;
  icon?: string;
  // Its real input in small, and what it found, for the board's live preview.
  preview?: Preview;
  found?: Found | null;
  stage?: number;
  meter?: Meter;
  output?: StepOutput | null;
  assignee?: string | null;
  role?: "orchestrator";
};
export type Section =
  | { title: string; kind: "table"; columns: string[]; rows: string[][] }
  | { title: string; kind: "list"; items: string[] }
  | { title: string; kind: "text"; body: string }
  | { title: string; kind: "cards"; cards: Array<{ title: string; subtitle: string; lines: string[] }> };
export type Result = { headline: string; stats: Array<{ value: string; label: string }>; sections: Section[] };
export type Plan = { scenario: string; prompt: string; pace: number; stage: number; stages: Array<{ label: string; short: string; icon: string }>; result: Result | null; error?: string };
export type Job = { id: string; name: string; queuedAt: number; doneAt: number | null; nodes: number | null; plan?: Plan };

// Today's refreshes, without the Assistant's plans.
export const refreshes = (jobs: Job[]) => jobs.filter((job) => !job.plan);
export type QueueWorker = { id: string; alive: boolean; leaving: boolean; done: number; current: string | null };
export type Term = { term: number; orchestrator: string; at: number };
export type RaftNode = {
  id: string;
  up: boolean;
  member: boolean;
  role?: "worker" | "candidate" | "orchestrator";
  term?: number;
  votes?: string[];
  members?: string[];
  commitIndex?: number;
  lastIndex?: number;
  // Milliseconds until this node would ask for votes, and since it last heard from an orchestrator.
  electionIn?: number;
  quietFor?: number | null;
};
export type ClusterEvent = { at: number; text: string };
export type ClusterState = {
  tasks: Task[];
  // Newest first.
  events: ClusterEvent[];
  jobs: Job[];
  workers: QueueWorker[];
  terms: Term[];
  now: number;
  auto: boolean;
  maxNodes: number;
  orchestrator: string | null;
  term: number | null;
  members: string[];
  nodes: RaftNode[];
};

const POLL_MS = 500;

function isClusterState(value: unknown): value is ClusterState {
  const state = value as ClusterState | null;
  return (
    Array.isArray(state?.tasks) &&
    Array.isArray(state?.jobs) &&
    Array.isArray(state?.workers) &&
    Array.isArray(state?.nodes) &&
    typeof state?.now === "number" &&
    state.tasks.every((task) => task && ["queued", "claimed", "done"].includes(task.status) && Array.isArray(task.runs)) &&
    state.nodes.every((node) => node && typeof node.id === "string" && typeof node.up === "boolean")
  );
}

// Polls the gateway, and keeps the gap between its clock and this browser's so
// the timeline can move smoothly between polls.
export function useCluster() {
  const [cluster, setCluster] = useState<ClusterState | null>(null);
  const [failed, setFailed] = useState(false);
  const offset = useRef(0);

  const load = useCallback(async () => {
    try {
      const response = await fetch(apiPath("/api/cluster/state"), { cache: "no-store" });
      const state: unknown = await response.json();
      if (!response.ok || !isClusterState(state)) throw new Error("Cluster unavailable");
      offset.current = state.now - Date.now();
      setCluster({ ...state, events: Array.isArray(state.events) ? state.events : [] });
      setFailed(false);
    } catch {
      setFailed(true);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(load, POLL_MS);
    return () => clearInterval(timer);
  }, [load]);

  return { cluster, failed, reload: load, serverNow: () => Date.now() + offset.current };
}

// Sends a Cluster view action to the gateway. Resolves with the error message, or null.
export async function send(path: string, body: unknown = {}): Promise<string | null> {
  try {
    const response = await fetch(apiPath(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.ok) return null;
    const data = await response.json().catch(() => null);
    return data?.error ?? `The cluster answered ${response.status}.`;
  } catch {
    return "The cluster is not reachable.";
  }
}

export type Source = "jira" | "slack" | "github";

// "Fetch Slack messages" comes from Slack; the ranking step has no source.
export function sourceOf(step: string): Source | null {
  const match = step.match(/\b(Jira|Slack|GitHub)\b/);
  return match ? (match[1].toLowerCase() as Source) : null;
}

// The short name drawn on a timeline block: "Slack", or "Rank".
export function shortName(step: string): string {
  const source = step.match(/\b(Jira|Slack|GitHub)\b/);
  return source ? source[1] : step.startsWith("Rank") ? "Rank" : step;
}

// A step in words while it runs: "Fetching Slack", "Ranking the list".
export function stepLabel(step: string): string {
  const name = shortName(step);
  if (name === "Rank") return "Ranking the list";
  return name === step ? step : `Fetching ${name}`;
}

// "Q-02" is the board's id on the network; people see "Board 2".
export function boardName(id: string): string {
  const number = id.match(/^Q-0*(\d+)$/)?.[1];
  return number ? `Board ${number}` : id;
}

// The same, for every board id inside a sentence from the cluster's log.
export function withBoardNames(text: string): string {
  return text.replace(/\bQ-\d+\b/g, boardName);
}

// One line of the cluster's log as a plain sentence, with task and job ids
// turned into what they are: "Board 1 took over Fetch Slack messages from
// Board 3 at 40%".
export function describeEvent(text: string, tasks: Task[]): string {
  const step = (id: string) => tasks.find((task) => task.id === id)?.input ?? "a step";
  const rules: Array<[RegExp, (...parts: string[]) => string]> = [
    [/^(\S+) resumed (T-\d+) \((.+)\) at (\d+%), lost by (\S+)$/, (who, _id, input, at, from) => `Orchestrator gave ${from}'s “${input}” to ${who} at ${at}`],
    [/^(\S+) claimed T-\d+ \((.+)\)$/, (who, input) => `${who} started “${input}”`],
    [/^(\S+) completed (T-\d+)$/, (who, id) => `${who} finished “${step(id)}”`],
    [/^(T-\d+) back in the queue at (\d+%), from (\S+)$/, (id, at, from) => `Orchestrator took “${step(id)}” back from ${from} at ${at}`],
    [/^(T-\d+) back in the queue at (\d+%)$/, (id, at) => `“${step(id)}” went back in the queue at ${at}`],
    [/^Plan J-\d+ done in (\S+ s) on (\d+) nodes?$/, (time, count) => `Job finished in ${time} on ${count} ${count === "1" ? "board" : "boards"}`],
    [/^J-\d+ .+ queued as (\d+) steps$/, (count) => `Refresh queued as ${count} steps`],
    [/^J-\d+ done in (\S+ s) on (\d+) nodes?$/, (time, count) => `Refresh finished in ${time} on ${count} ${count === "1" ? "board" : "boards"}`],
    [/^(\S+) stopped responding$/, (who) => `${who} stopped responding`],
    [/^(\S+) elected orchestrator for term (\d+)$/, (who) => `${who} was elected orchestrator`],
    [/^Members are now (.*)$/, (list) => `Boards in the cluster: ${list}`],
  ];
  for (const [pattern, say] of rules) {
    const match = text.match(pattern);
    if (match) return withBoardNames(say(...match.slice(1)));
  }
  return withBoardNames(text);
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
