import { setTimeout as sleep } from "node:timers/promises";
import type { Found, Json, SkillContext, StepOutput } from "./plan.ts";
import type { ClaimResult, Task } from "./queue.ts";
import { runSkill } from "./scenarios/index.ts";

// What a plan step produced, from its skill on the scenario's demo data or the model. A
// skill that throws still finishes the step, with the error as its result.
async function outputOf(task: Task, context: SkillContext): Promise<StepOutput | undefined> {
  if (!task.skill || !task.scenario) return undefined;
  try {
    return await runSkill(task.scenario, task.skill, task.params, context);
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
      // A live skill says how far it really is and what it has found and done so far; the next beat
      // carries whatever changed. A demo skill answers at once, and its first beat carries what it found.
      let output: StepOutput | undefined;
      let real: number | null = null;
      let pending: { found?: Found; partial?: Json } = {};
      const report = (progress: number, found?: Found, partial?: Json) => {
        real = Math.max(real ?? 0, Math.min(progress, 0.99));
        pending = { ...pending, ...(found && { found }), ...(partial !== undefined && { partial }) };
      };
      const beat = setInterval(() => {
        const changes = pending;
        pending = {};
        call({ type: "progress", worker: id, task: task.id, progress: real ?? done(), ...changes }).catch(() => (pending = { ...changes, ...pending }));
      }, heartbeatMs);
      // A board losing power mid-step stops reporting at once, so its lease runs out and the step moves.
      signal?.addEventListener("abort", () => clearInterval(beat), { once: true });
      try {
        output = await outputOf(task, { partial: (task.partial as Json) ?? null, report });
        if (output?.found && !real) pending.found = output.found;
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
