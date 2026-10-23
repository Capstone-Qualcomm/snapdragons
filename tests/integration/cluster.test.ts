import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { mock, test } from "node:test";
import { createClusterServer, REFRESH } from "../../backend/cluster/server.ts";

// Real node processes behind the gateway, with fast timings so each test takes seconds.
type Run = { worker: string; from: number; outcome: string };
type State = {
  orchestrator: string | null;
  term: number | null;
  members: string[];
  nodes: Array<{ id: string; up: boolean }>;
  tasks: Array<{ id: string; status: string; worker: string | null; job: string; progress: number; lostBy: string[]; runs: Run[]; stage?: number }>;
  jobs: Array<{ id: string; doneAt: number | null; nodes: number | null; plan?: { result: { sections: Array<{ title: string; rows?: string[][] }> } | null } }>;
};

async function startCluster(nodePort: number, size = 3, dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"))) {
  const { server, startCluster: startNodes, stopNodes } = createClusterServer({
    port: 0,
    nodePort,
    dataDir,
    nodeEnv: { WORK_MS: "1500", LEASE_MS: "1000", RAFT_HEARTBEAT_MS: "100", RAFT_ELECTION_MIN_MS: "500", RAFT_ELECTION_MAX_MS: "1000" },
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  const state = async () => (await (await fetch(`${base}/api/cluster/state`)).json()) as State;
  async function until(check: (current: State) => boolean, what: string, attempts = 200): Promise<State> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error(`Timed out waiting until ${what}.`);
  }
  const post = (path: string, body: unknown = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body) });
  const refresh = async () => ((await (await post("/api/cluster/refresh")).json()) as { job: { id: string } }).job.id;
  const jobDone = (job: string) => (current: State) => current.jobs.some((entry) => entry.id === job && entry.doneAt !== null);

  const close = () => {
    server.close();
    stopNodes();
  };
  try {
    startNodes(size);
    await until((current) => current.orchestrator !== null && current.nodes.filter((node) => node.up).length >= size, "an orchestrator is elected");
  } catch (cause) {
    close();
    throw cause;
  }
  return { state, until, post, refresh, jobDone, close };
}

test("three nodes elect an orchestrator and split a refresh, each step done once", async () => {
  const cluster = await startCluster(4601);
  try {
    const job = await cluster.refresh();
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    const steps = done.tasks.filter((task) => task.job === job);

    assert.equal(steps.length, REFRESH.steps.length + 1);
    for (const step of steps) assert.deepEqual(step.runs.map((run) => run.outcome), ["done"]);
    assert.equal(done.jobs.find((entry) => entry.id === job)!.nodes, 3);
  } finally {
    cluster.close();
  }
});

test("killing the orchestrator mid-step: a new one is elected and the step resumes from its checkpoint", async () => {
  const cluster = await startCluster(4611);
  try {
    const job = await cluster.refresh();
    const busy = await cluster.until((current) => current.tasks.some((task) => task.worker === current.orchestrator && task.status === "claimed" && task.progress >= 0.3), "the orchestrator is partway through a step");
    const old = { id: busy.orchestrator!, term: busy.term! };
    const victim = busy.tasks.find((task) => task.worker === old.id && task.status === "claimed")!;

    // SIGKILL, like pulling the power on the board that holds the queue.
    assert.equal((await cluster.post(`/api/cluster/nodes/${old.id}/kill`)).status, 200);
    const after = await cluster.until((current) => current.orchestrator !== null && current.orchestrator !== old.id, "a new orchestrator is elected");
    assert.ok(after.term! > old.term);

    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    const resumed = done.tasks.find((task) => task.id === victim.id)!;
    assert.deepEqual(resumed.lostBy, [old.id]);
    assert.equal(resumed.runs[0].outcome, "lost");
    assert.ok(resumed.runs[1].from >= 0.3, `resumed from ${resumed.runs[1].from}`);
    assert.ok(done.tasks.filter((task) => task.job === job).every((task) => task.status === "done"));
  } finally {
    cluster.close();
  }
});

test("every node restarts at once and the queue comes back from disk", async () => {
  const cluster = await startCluster(4621);
  try {
    const job = await cluster.refresh();
    await cluster.until(cluster.jobDone(job), "the refresh is done");

    await cluster.post("/api/cluster/restart");
    await cluster.until((current) => current.nodes.every((node) => !node.up), "every node is down");
    // A new orchestrator replays the saved log once its first entry commits.
    const back = await cluster.until((current) => current.orchestrator !== null && cluster.jobDone(job)(current), "the queue is back");
    assert.equal(back.nodes.filter((node) => node.up).length, 3);
    assert.equal(back.tasks.filter((task) => task.job === job).length, REFRESH.steps.length + 1);
  } finally {
    cluster.close();
  }
});

test("a node is added, then removed after it finishes its step, and stays out when the gateway starts again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"));
  const cluster = await startCluster(4631, 2, dataDir);
  try {
    assert.deepEqual(await (await cluster.post("/api/cluster/nodes")).json(), { id: "Q-03" });
    await cluster.until((current) => current.members.includes("Q-03") && current.nodes.some((node) => node.id === "Q-03" && node.up), "Q-03 joins");

    const job = await cluster.refresh();
    await cluster.until((current) => current.tasks.some((task) => task.worker === "Q-03" && task.status === "claimed"), "Q-03 works on a step");
    assert.equal((await cluster.post("/api/cluster/nodes/Q-03/remove")).status, 200);

    const gone = await cluster.until((current) => !current.members.includes("Q-03") && !current.nodes.some((node) => node.id === "Q-03"), "Q-03 leaves");
    const step = gone.tasks.find((task) => task.runs.some((run) => run.worker === "Q-03"))!;
    assert.deepEqual(step.runs.map((run) => [run.worker, run.outcome]), [["Q-03", "done"]]);
    await cluster.until(cluster.jobDone(job), "the refresh is done");
  } finally {
    cluster.close();
  }
  await sleep(500);

  // Q-03's saved log still names it, but its removal committed, so it does not come back.
  const again = await startCluster(4631, 2, dataDir);
  try {
    await sleep(500);
    assert.deepEqual((await again.state()).nodes.map((node) => node.id), ["Q-01", "Q-02"]);
  } finally {
    again.close();
  }
});

test("the last node cannot be removed, and it keeps working", async () => {
  const cluster = await startCluster(4661, 1);
  try {
    const refused = await cluster.post("/api/cluster/nodes/Q-01/remove");
    assert.equal(refused.status, 409);
    assert.match((await refused.json()).error, /last node/);
    const job = await cluster.refresh();
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    assert.deepEqual(done.members, ["Q-01"]);
  } finally {
    cluster.close();
  }
});

test("a cluster grown to six nodes comes back as six when the gateway starts again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"));
  const first = await startCluster(4641, 3, dataDir);
  try {
    for (const id of ["Q-04", "Q-05", "Q-06"]) {
      assert.deepEqual(await (await first.post("/api/cluster/nodes")).json(), { id });
      await first.until((current) => current.members.includes(id) && current.nodes.some((node) => node.id === id && node.up), `${id} joins`);
    }
  } finally {
    first.close();
  }
  await sleep(500);

  // The same command as before: three nodes, but the saved logs say there are six.
  const again = await startCluster(4641, 3, dataDir);
  try {
    const back = await again.state();
    assert.equal(back.members.length, 6);
    assert.equal(back.nodes.filter((node) => node.up).length, 6);
  } finally {
    again.close();
  }
});

test("Add with every node dead brings the saved members back instead of starting a new cluster", async () => {
  const cluster = await startCluster(4651);
  try {
    const job = await cluster.refresh();
    await cluster.until(cluster.jobDone(job), "the refresh is done");
    for (const id of ["Q-01", "Q-02", "Q-03"]) assert.equal((await cluster.post(`/api/cluster/nodes/${id}/kill`)).status, 200);
    await cluster.until((current) => current.nodes.every((node) => !node.up), "every node is down");

    assert.equal((await cluster.post("/api/cluster/nodes")).status, 201);
    const back = await cluster.until((current) => current.orchestrator !== null && cluster.jobDone(job)(current), "the saved cluster is back");
    assert.deepEqual(back.members, ["Q-01", "Q-02", "Q-03"]);
  } finally {
    cluster.close();
  }
});

test("one damaged saved log is reported and left alone while the other nodes come back", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"));
  const first = await startCluster(4671, 3, dataDir);
  let job: string;
  try {
    job = await first.refresh();
    await first.until(first.jobDone(job), "the refresh is done");
  } finally {
    first.close();
  }
  await sleep(500);
  writeFileSync(join(dataDir, "Q-01.json"), "{damaged");

  const errors = mock.method(console, "error", () => {});
  try {
    // Q-02 and Q-03 are a majority of the three, so they carry on without Q-01.
    const again = await startCluster(4671, 2, dataDir);
    try {
      const back = await again.until((current) => current.orchestrator !== null && again.jobDone(job)(current), "the queue is back");
      assert.ok(["Q-02", "Q-03"].includes(back.orchestrator!));
    } finally {
      again.close();
    }
    assert.ok(errors.mock.calls.some((call) => /Q-01\.json/.test(String(call.arguments[0]))), "the gateway names the damaged file");
  } finally {
    errors.mock.restore();
  }
  assert.equal(readFileSync(join(dataDir, "Q-01.json"), "utf8"), "{damaged");
});

test("a removal cut off halfway, saved only by the orchestrator it removes, still finishes when the gateway starts again", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "cluster-test-"));
  const first = await startCluster(4681, 2, dataDir);
  let removed: string;
  try {
    removed = (await first.state()).orchestrator!;
  } finally {
    first.close();
  }
  await sleep(500);
  // As if the orchestrator saved the entry taking itself out, then the gateway stopped before the other node got it.
  const file = join(dataDir, `${removed}.json`);
  const saved = JSON.parse(readFileSync(file, "utf8"));
  const remaining = ["Q-01", "Q-02"].filter((id) => id !== removed);
  saved.log.push({ term: saved.log.at(-1).term, command: { type: "config", members: remaining, at: Date.now() } });
  writeFileSync(file, JSON.stringify(saved));

  // The other node still counts two members, so it cannot win an election alone.
  const again = await startCluster(4681, 1, dataDir);
  try {
    const back = await again.until((current) => current.orchestrator === remaining[0], `${remaining[0]} is the orchestrator`);
    assert.deepEqual(back.members, remaining);
  } finally {
    again.close();
  }
});

test("an Assistant plan survives a worker and then the orchestrator being killed, and still produces its result", async () => {
  // Five boards, so with two killed the other three are still a majority and can elect.
  const cluster = await startCluster(4641, 5);
  try {
    const run = await cluster.post("/api/assistant/run", { scenario: "student", pace: "fast" });
    const job = ((await run.json()) as { job: { id: string } }).job.id;
    const reading = await cluster.until((current) => current.tasks.some((task) => task.job === job && task.status === "claimed" && task.worker !== current.orchestrator && task.progress >= 0.2), "a worker is partway through reading the inbox");
    const victim = reading.tasks.find((task) => task.job === job && task.status === "claimed" && task.worker !== reading.orchestrator)!;
    assert.equal((await cluster.post(`/api/cluster/nodes/${victim.worker}/kill`)).status, 200);

    const second = await cluster.until((current) => current.tasks.some((task) => task.job === job && task.stage === 1), "the orchestrator plans the second step", 400);
    const old = second.orchestrator!;
    assert.equal((await cluster.post(`/api/cluster/nodes/${old}/kill`)).status, 200);

    const done = await cluster.until(cluster.jobDone(job), "the plan is done", 600);
    assert.notEqual(done.orchestrator, old);
    assert.deepEqual(done.tasks.find((task) => task.id === victim.id)!.lostBy, [victim.worker]);
    const replies = done.jobs.find((entry) => entry.id === job)!.plan!.result!.sections[0].rows!;
    assert.equal(replies.length, 6);
  } finally {
    cluster.close();
  }
});
