import { setTimeout as sleep } from "node:timers/promises";
import type { StepOutput } from "./plan.ts";
import type { ClaimResult, Task } from "./queue.ts";
import { runSkill } from "./scenarios/index.ts";

// What a plan step produced, from its skill on the scenario's demo data. A
// skill that throws still finishes the step, with the error as its result.
function outputOf(task: Task): StepOutput | undefined {
  if (!task.skill || !task.scenario) return undefined;
  try {
    return runSkill(task.scenario, task.skill, task.params);
  } catch (cause) {
    return { summary: `Failed: ${(cause as Error).message}`, short: "Failed", data: null };
  }
}

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
      // The skill runs on demo data, so its answer is ready at once; the step then
      // takes its time so a person can watch, and its first heartbeat carries what
      // it found so the page can light it up as the board goes.
      const output = outputOf(task);
      let foundSent = !output?.found;
      // A plan step says how long it should take, so a person can follow it; give or take 10%.
      const total = task.durationMs ? task.durationMs * (0.9 + Math.random() / 5) : workMs * (0.75 + Math.random() / 2);
      const startedAt = Date.now();
      const done = () => Math.min(0.99, from + (Date.now() - startedAt) / total);
      // Each heartbeat carries a checkpoint, so the queue knows how far this node got.
      const beat = setInterval(() => {
        const found = foundSent ? undefined : output!.found;
        call({ type: "progress", worker: id, task: task.id, progress: done(), ...(found && { found }) }).then(() => (foundSent = true), () => {});
      }, heartbeatMs);
      try {
        await sleep(total * (1 - from), undefined, { signal });
      } finally {
        clearInterval(beat);
      }
      // The finished step must not be lost to a leader election, so keep trying until the queue answers.
      while (true) {
        try {
          await call({ type: "complete", worker: id, task: task.id, ...(output && { output }) });
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
