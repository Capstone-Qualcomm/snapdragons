import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
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

test("a plan step's first heartbeat carries what the skill found, and its completion the full output", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let claims = 0;
  await runWorker({
    id: "Q-02",
    pollMs: 20,
    heartbeatMs: 60,
    call: async (command) => {
      calls.push(command);
      if (command.type === "claim") return claims++ ? { task: null, leave: true } : { task: { id: "T-1", progress: 0, skill: "inbox", scenario: "student", params: { from: 1, to: 40 }, durationMs: 300 } };
      return true;
    },
  });
  const beats = calls.filter((call) => call.type === "progress");
  assert.ok(beats.length >= 2);
  assert.deepEqual((beats[0].found as { chips: string[] }).chips, ["northwind-robotics.example"]);
  assert.ok(beats.slice(1).every((beat) => !beat.found));
  const complete = calls.find((call) => call.type === "complete")!;
  assert.equal((complete.output as { short: string }).short, "2 replies");
});

test("a worker drops a step the queue took back or stopped, and asks for another", async () => {
  const calls: Array<Record<string, unknown>> = [];
  let claims = 0;
  const startedAt = Date.now();
  await runWorker({
    id: "Q-02",
    workMs: 5000,
    pollMs: 20,
    heartbeatMs: 50,
    call: async (command) => {
      calls.push(command);
      if (command.type === "claim") return claims++ ? { task: null, leave: true } : { task: { id: "T-1", progress: 0 } };
      // The step is no longer this worker's.
      return command.type === "progress" ? false : true;
    },
  });

  // The step would take at least 3.75 s; dropped at the first beat, the worker is back claiming at once.
  assert.ok(Date.now() - startedAt < 1000);
  assert.equal(calls.filter((call) => call.type === "progress").length, 1);
  assert.equal(calls.filter((call) => call.type === "complete").length, 0);
});

test("a heartbeat waits for the one before it to land, so slow beats neither pile up nor arrive out of order", async () => {
  let inFlight = 0;
  let most = 0;
  let claims = 0;
  await runWorker({
    id: "Q-02",
    workMs: 600,
    pollMs: 20,
    heartbeatMs: 20,
    call: async (command) => {
      if (command.type === "claim") return claims++ ? { task: null, leave: true } : { task: { id: "T-1", progress: 0 } };
      if (command.type !== "progress") return true;
      // A relay that takes 100 ms a beat.
      most = Math.max(most, ++inFlight);
      await sleep(100);
      inFlight--;
      return true;
    },
  });
  assert.equal(most, 1);
});

// Runs one claimed step to completion against services answering with reply, and returns what was asked and reported.
async function runFetch(task: Record<string, unknown>, reply: (path: string) => [number, unknown]) {
  const asked: string[] = [];
  const services = createServer((req, res) => {
    asked.push(req.url ?? "");
    const [status, body] = reply(req.url ?? "");
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => services.listen(0, "127.0.0.1", resolve));
  const before = process.env.SERVICES_URL;
  process.env.SERVICES_URL = `http://127.0.0.1:${(services.address() as AddressInfo).port}`;
  const completed: Array<Record<string, unknown>> = [];
  let claims = 0;
  try {
    await runWorker({
      id: "Q-02",
      workMs: 50,
      pollMs: 10,
      heartbeatMs: 20,
      call: async (command) => {
        if (command.type === "claim") return claims++ ? { task: null, leave: true } : { task: { progress: 0, ...task } };
        if (command.type === "complete") completed.push(command);
        return true;
      },
    });
  } finally {
    if (before === undefined) delete process.env.SERVICES_URL;
    else process.env.SERVICES_URL = before;
    services.close();
  }
  return { asked, output: completed[0]?.output as { summary: string; short: string; data: unknown } | undefined };
}

test("a fetch step loads its source through the services, as the browser that asked, and reports only the count", async () => {
  const { asked, output } = await runFetch({ id: "T-2", source: "slack", asker: "handle-1" }, () => [200, { items: [{ text: "hi" }, { text: "ship it" }] }]);
  assert.deepEqual(asked, ["/sources/slack?asker=handle-1"]);
  assert.deepEqual(output, { summary: "Loaded 2 Slack messages", short: "2 messages", data: { source: "slack", count: 2 } });
});

test("a fetch step of one item says so in the singular", async () => {
  const { output } = await runFetch({ id: "T-1", source: "jira", asker: "handle-1" }, () => [200, { items: [{ key: "QT1S-46" }] }]);
  assert.equal(output?.summary, "Loaded 1 Jira ticket");
  assert.equal(output?.short, "1 ticket");
});

test("a fetch step nobody asked for loads nothing, and asks the services nothing", async () => {
  const { asked, output } = await runFetch({ id: "T-3", source: "github", asker: null }, () => [500, {}]);
  assert.deepEqual(asked, []);
  assert.equal(output?.short, "Skipped");
  assert.equal(output?.data, null);
});

test("a source that refuses comes back as the step's result, not as a failed board", async () => {
  const { output } = await runFetch({ id: "T-4", source: "outlook", asker: "handle-1" }, () => [401, { error: "Outlook is not connected. Connect Outlook." }]);
  assert.deepEqual(output, { summary: "Outlook not loaded: Outlook is not connected. Connect Outlook.", short: "Not loaded", data: null });
});
