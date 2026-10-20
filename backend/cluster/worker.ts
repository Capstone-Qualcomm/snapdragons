import { setTimeout as sleep } from "node:timers/promises";
import type { ClaimResult } from "./queue.ts";

type WorkerOptions = {
  id: string;
  // Sends a queue command to the cluster and resolves with the queue's answer.
  // It throws while there is no leader, so the worker waits and asks again.
  call: (command: Record<string, unknown>) => Promise<unknown>;
  workMs?: number;
  pollMs?: number;
  heartbeatMs?: number;
  signal?: AbortSignal;
};

// The work loop each node runs next to its Raft peer. It returns when the queue
// tells it to leave, after a Remove.
export async function runWorker({ id, call, workMs = 1000, pollMs = 500, heartbeatMs = 500, signal }: WorkerOptions): Promise<void> {
  while (!signal?.aborted) {
    try {
      const { task, leave } = (await call({ type: "claim", worker: id })) as ClaimResult;
      if (leave) return;
      if (!task) {
        await sleep(pollMs, undefined, { signal });
        continue;
      }
      // Stand-in for real work (an API request, an LLM call): it just takes time,
      // somewhere between 75% and 125% of workMs so nodes finish at different times.
      // A step handed over from a node that died starts from that node's last checkpoint.
      // The checkpoint is read once: on the orchestrator, task is the queue's own copy and each heartbeat moves it.
      const from = task.progress;
      const total = workMs * (0.75 + Math.random() / 2);
      const startedAt = Date.now();
      const done = () => Math.min(0.99, from + (Date.now() - startedAt) / total);
      // Each heartbeat carries a checkpoint, so the queue knows how far this node got.
      const beat = setInterval(() => {
        call({ type: "progress", worker: id, task: task.id, progress: done() }).catch(() => {});
      }, heartbeatMs);
      try {
        await sleep(total * (1 - from), undefined, { signal });
      } finally {
        clearInterval(beat);
      }
      // The finished step must not be lost to a leader election, so keep trying until the queue answers.
      while (true) {
        try {
          await call({ type: "complete", worker: id, task: task.id });
          break;
        } catch {
          await sleep(pollMs, undefined, { signal });
        }
      }
    } catch {
      if (signal?.aborted) break;
      await sleep(pollMs);
    }
  }
}
