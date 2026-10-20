import assert from "node:assert/strict";
import { test } from "node:test";
import { runWorker } from "./worker.ts";

test("a worker resumes a handed-over step from its checkpoint, and keeps trying to report it done", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let claims = 0;
  let failures = 2;
  const startedAt = Date.now();
  await runWorker({
    id: "Q-02",
    workMs: 1000,
    pollMs: 20,
    heartbeatMs: 100,
    call: async (command) => {
      calls.push(command);
      if (command.type === "claim") return claims++ ? { task: null, leave: true } : { task: { id: "T-1", progress: 0.8 } };
      // The first two tries land during an election.
      if (command.type === "complete" && failures-- > 0) throw new Error("There is no orchestrator right now.");
      return true;
    },
  });

  // 20% of a step that takes 750 to 1250 ms is at most 250 ms, plus the retries.
  assert.ok(Date.now() - startedAt < 600);
  assert.equal(calls.filter((call) => call.type === "complete").length, 3);
  const beats = calls.filter((call) => call.type === "progress").map((call) => call.progress as number);
  assert.ok(beats.every((progress) => progress >= 0.8));
});

test("checkpoints count from where the step started, even when the claimed task is updated by each heartbeat", async () => {
  // On the orchestrator the claim answers with the queue's own task, which each committed heartbeat moves forward.
  const task = { id: "T-1", progress: 0 };
  const beats: Array<{ progress: number; elapsed: number }> = [];
  let claims = 0;
  let claimedAt = 0;
  await runWorker({
    id: "Q-01",
    workMs: 1000,
    pollMs: 20,
    heartbeatMs: 100,
    call: async (command) => {
      if (command.type === "claim") {
        claimedAt = Date.now();
        return claims++ ? { task: null, leave: true } : { task };
      }
      if (command.type === "progress") {
        beats.push({ progress: command.progress as number, elapsed: Date.now() - claimedAt });
        task.progress = command.progress as number;
      }
      return true;
    },
  });

  // The step takes at least 750 ms, so no checkpoint can be ahead of the time spent over 750 ms.
  assert.ok(beats.length >= 3);
  for (const beat of beats) assert.ok(beat.progress <= beat.elapsed / 750 + 0.05, `${beat.progress} after ${beat.elapsed} ms`);
});
