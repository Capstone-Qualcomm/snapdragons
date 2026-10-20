import { useCallback, useEffect, useRef, useState } from "react";
import { apiPath } from "../../lib/urls";

// The shape of GET /api/cluster/state, from backend/cluster/server.ts.

export type Run = { worker: string; start: number; heardAt: number; end: number | null; from: number; to: number; outcome: "running" | "done" | "lost" };
export type Task = { id: string; input: string; status: "queued" | "claimed" | "done"; worker: string | null; lostBy: string[]; job: string | null; after: string[]; progress: number; runs: Run[] };
export type Job = { id: string; name: string; queuedAt: number; doneAt: number | null; nodes: number | null };
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

export type Source = "jira" | "slack" | "github" | "outlook";

// "Fetch Slack messages" comes from Slack; the ranking step has no source.
export function sourceOf(step: string): Source | null {
  const match = step.match(/\b(Jira|Slack|GitHub|Outlook)\b/);
  return match ? (match[1].toLowerCase() as Source) : null;
}

// The short name drawn on a timeline block.
export function shortName(step: string): string {
  return step.replace(/^Fetch /, "").replace(/^Rank today's list$/, "Rank");
}

// Jobs are numbered J-1, J-2, ..., so the number picks one of five colors.
export function jobColor(job: string | null): string {
  return `job-${job ? Number(job.slice(2)) % 5 : 0}`;
}

export function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)} s`;
}
