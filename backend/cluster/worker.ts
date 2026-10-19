import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { Task } from "./queue.ts";

type WorkerOptions = {
  id: string;
  url: string;
  workMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
};

// One worker is one process. It only talks to the queue over HTTP, so the same
// file can run on a laptop now and on an Uno Q board later by changing the URL.
export async function runWorker({ id, url, workMs = 1000, pollMs = 500, heartbeatMs = 1000, signal }: WorkerOptions): Promise<void> {
  const base = url.replace(/\/$/, "");

  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(base + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw new Error(`${path} returned ${response.status}`);
    return (await response.json()) as T;
  }

  while (!signal?.aborted) {
    try {
      const { task } = await post<{ task: Task | null }>("/api/cluster/claim", { worker: id });
      if (!task) {
        await sleep(pollMs, undefined, { signal });
        continue;
      }
      console.log(`${id} claimed ${task.id}: ${task.input}`);
      // Keep telling the queue we are alive while the work runs, or it will
      // hand the task to another worker once the lease runs out.
      const beat = setInterval(() => {
        post("/api/cluster/heartbeat", { worker: id }).catch(() => {});
      }, heartbeatMs);
      try {
        // Stand-in for real work (an LLM call, an API request). It just takes time,
        // somewhere between 75% and 125% of workMs so nodes finish at different times.
        await sleep(workMs * (0.75 + Math.random() / 2), undefined, { signal });
        await post("/api/cluster/complete", { id: task.id, worker: id, result: `${task.input} (handled by ${id})` });
      } finally {
        clearInterval(beat);
      }
      console.log(`${id} finished ${task.id}`);
    } catch (cause) {
      if (signal?.aborted) break;
      // The queue may not be up yet, or may have restarted. Wait and try again.
      console.error(`${id}: ${cause instanceof Error ? cause.message : cause}`);
      await sleep(pollMs);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const id = process.env.WORKER_ID ?? process.argv[2];
  if (!id) {
    console.error("Give the worker a name: WORKER_ID=Q-01 npm run worker");
    process.exit(1);
  }
  const controller = new AbortController();
  process.on("SIGINT", () => controller.abort());
  process.on("SIGTERM", () => controller.abort());
  await runWorker({
    id,
    url: process.env.CLUSTER_URL ?? `http://localhost:${process.env.CLUSTER_PORT ?? 3003}`,
    workMs: Number(process.env.WORK_MS ?? 1000),
    heartbeatMs: Number(process.env.HEARTBEAT_MS ?? 1000),
    signal: controller.signal,
  });
}
