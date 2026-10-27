import { setTimeout as sleep } from "node:timers/promises";
import type { StepOutput } from "./plan.ts";
import type { ClaimResult, Task } from "./queue.ts";
import { runSkill } from "./scenarios/index.ts";

// What a plan step produced, from its skill on the scenario's demo data or the model. A
// skill that throws still finishes the step, with the error as its result.
async function outputOf(task: Task): Promise<StepOutput | undefined> {
  if (!task.skill || !task.scenario) return undefined;
  try {
    return await runSkill(task.scenario, task.skill, task.params);
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
      // A step handed over from a node that died starts from that node's last checkpoint.
      // The checkpoint is read once: on the orchestrator, task is the queue's own copy and each heartbeat moves it.
      const from = task.progress;
      // A plan step says how long it should take, so a person can follow it; give or take 10%.
      // Other steps stand in for real work and take 75% to 125% of workMs, so nodes finish at different times.
      const total = task.durationMs ? task.durationMs * (0.9 + Math.random() / 5) : workMs * (0.75 + Math.random() / 2);
      const startedAt = Date.now();
      const done = () => Math.min(0.99, from + (Date.now() - startedAt) / total);
      // Each heartbeat carries a checkpoint, so the queue knows how far this node got. Beats start
      // before the skill runs, since a model call takes seconds and silence would look like a dead board.
      // The first beat after the skill answers carries what it found, so the page can light it up.
      let output: StepOutput | undefined;
      let foundSent = true;
      const beat = setInterval(() => {
        const found = foundSent ? undefined : output?.found;
        call({ type: "progress", worker: id, task: task.id, progress: done(), ...(found && { found }) }).then(() => found && (foundSent = true), () => {});
      }, heartbeatMs);
      try {
        output = await outputOf(task);
        foundSent = !output?.found;
        // Demo data answers at once, so the step then takes the rest of its time for a person to watch.
        await sleep(Math.max(0, total * (1 - from) - (Date.now() - startedAt)), undefined, { signal });
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
