import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
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
  tasks: Array<{ id: string; status: string; worker: string | null; job: string; progress: number; lostBy: string[]; runs: Run[]; stage?: number; source?: string; output?: { summary: string; data: unknown } | null }>;
  jobs: Array<{ id: string; doneAt: number | null; nodes: number | null; plan?: { result: { sections: Array<{ title: string; rows?: string[][] }> } | null } }>;
};

// fetching has the boards load each source in a refresh from the source backends at sourceUrls, as the app at appUrl.
type Fetching = { appUrl: string; sourceUrls: Record<string, string> };

async function startCluster(nodePort: number, size = 3, dataDir = mkdtempSync(join(tmpdir(), "cluster-test-")), fetching?: Fetching) {
  const nodeEnv: Record<string, string> = { WORK_MS: "1500", LEASE_MS: "1000", RAFT_HEARTBEAT_MS: "100", RAFT_ELECTION_MIN_MS: "500", RAFT_ELECTION_MAX_MS: "1000" };
  const { server, servicesServer, startCluster: startNodes, stopNodes } = createClusterServer({
    port: 0,
    nodePort,
    dataDir,
    nodeEnv,
    ...fetching,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  if (fetching) {
    // The boards reach the services the way real ones do, at SERVICES_URL. Set before any node starts.
    await new Promise<void>((resolve) => servicesServer.listen(0, "127.0.0.1", resolve));
    nodeEnv.SERVICES_URL = `http://127.0.0.1:${(servicesServer.address() as AddressInfo).port}`;
  }

  const state = async () => (await (await fetch(`${base}/api/cluster/state`)).json()) as State;
  async function until(check: (current: State) => boolean, what: string, attempts = 200): Promise<State> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      const current = await state();
      if (check(current)) return current;
      await sleep(100);
    }
    throw new Error(`Timed out waiting until ${what}.`);
  }
  const post = (path: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(base + path, { method: "POST", body: JSON.stringify(body), headers });
  const refresh = async () => ((await (await post("/api/cluster/refresh")).json()) as { job: { id: string } }).job.id;
  const jobDone = (job: string) => (current: State) => current.jobs.some((entry) => entry.id === job && entry.doneAt !== null);

  const close = () => {
    server.close();
    if (servicesServer.listening) servicesServer.close();
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
    // Nobody signed in asked for it, so each fetch step loads nothing and says so.
    const fetches = steps.filter((step) => step.source);
    assert.deepEqual(fetches.map((step) => step.source), REFRESH.sources);
    assert.ok(fetches.every((step) => step.output?.summary === "No signed-in browser asked for this refresh, so nothing was loaded"));
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

// Stand-in source backends: each serves its list only to the browser whose sid it was given, the way
// the real ones only serve a connected session, and Outlook says it is not connected.
const SID = "ab".repeat(32);
const APP = "http://app.test";
async function startSources() {
  const asked: Array<{ path: string; sid: string | null }> = [];
  const lists: Record<string, [string, unknown[]]> = {
    "/api/jira/issues": ["issues", [{ key: "QT1S-46" }, { key: "QT1S-10" }, { key: "QT1S-53" }]],
    "/api/slack/messages": ["messages", [{ text: "Can you review my PR?" }, { text: "Demo is at 2" }]],
    "/api/github/issues": ["issues", [{ title: "Snapshot the queue" }]],
    "/api/teams/messages": ["messages", [{ text: "Standup moved to 10" }, { text: "Slides?" }, { text: "Thanks!" }, { text: "See you there" }]],
  };
  const server = createServer((req, res) => {
    const sid = req.headers.cookie?.match(/(?:^|;\s*)sid=([0-9a-f]{64})/)?.[1] ?? null;
    asked.push({ path: req.url ?? "", sid });
    const list = lists[req.url ?? ""];
    const [status, body] = sid !== SID || !list ? [401, { error: "Outlook is not connected. Connect Outlook." }] : [200, { [list[0]]: list[1] }];
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { asked, server, fetching: { appUrl: APP, sourceUrls: { jira: url, slack: url, github: url, outlook: url, teams: url } } };
}

const outputs = (state: State, job: string) => Object.fromEntries(state.tasks.filter((task) => task.job === job && task.source).map((task) => [task.source, task.output?.summary]));

test("boards fetch each source as the browser that asked, and only what they loaded reaches the cluster", async () => {
  const sources = await startSources();
  const cluster = await startCluster(4701, 3, undefined, sources.fetching);
  try {
    const response = await cluster.post("/api/cluster/refresh", {}, { origin: APP, cookie: `sid=${SID}` });
    const job = ((await response.json()) as { job: { id: string } }).job.id;
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");

    assert.deepEqual(outputs(done, job), {
      jira: "Loaded 3 Jira tickets",
      slack: "Loaded 2 Slack messages",
      github: "Loaded 1 GitHub issue",
      outlook: "Outlook not loaded: Outlook is not connected. Connect Outlook.",
      teams: "Loaded 4 Teams messages",
    });
    // Each source was asked once, as that browser.
    assert.deepEqual(sources.asked.map((request) => request.path).sort(), ["/api/github/issues", "/api/jira/issues", "/api/outlook/messages", "/api/slack/messages", "/api/teams/messages"]);
    assert.ok(sources.asked.every((request) => request.sid === SID));
    // The pages see counts, never the browser's sid, the handle standing for it, or the items themselves.
    const seen = JSON.stringify(done);
    assert.ok(!seen.includes(SID) && !seen.includes("asker") && !seen.includes("Can you review my PR?"));
  } finally {
    cluster.close();
    sources.server.close();
  }
});

test("the browser that asked collects what the boards loaded, and nobody else can", async () => {
  const sources = await startSources();
  const cluster = await startCluster(4731, 3, undefined, sources.fetching);
  const collect = (job: string, source: string, headers: Record<string, string>) => cluster.post(`/api/cluster/refresh/${job}/${source}`, {}, headers);
  const asker = { origin: APP, cookie: `sid=${SID}` };
  try {
    const response = await cluster.post("/api/cluster/refresh", {}, asker);
    const job = ((await response.json()) as { job: { id: string } }).job.id;
    await cluster.until(cluster.jobDone(job), "the refresh is done");

    // Each list as its source served it, under the same name, so Today reads it like the source's own.
    const lists: Record<string, unknown> = {};
    for (const source of ["jira", "slack", "github", "teams"]) {
      const answer = await collect(job, source, asker);
      assert.equal(answer.status, 200, source);
      lists[source] = await answer.json();
    }
    assert.deepEqual(lists, {
      jira: { issues: [{ key: "QT1S-46" }, { key: "QT1S-10" }, { key: "QT1S-53" }] },
      slack: { messages: [{ text: "Can you review my PR?" }, { text: "Demo is at 2" }] },
      github: { issues: [{ title: "Snapshot the queue" }] },
      teams: { messages: [{ text: "Standup moved to 10" }, { text: "Slides?" }, { text: "Thanks!" }, { text: "See you there" }] },
    });
    // Outlook refused the boards, so there is nothing to collect and Today loads it itself.
    assert.equal((await collect(job, "outlook", asker)).status, 404);
    // Another browser, another site, another job and a made-up source get nothing.
    assert.equal((await collect(job, "slack", { origin: APP, cookie: `sid=${"cd".repeat(32)}` })).status, 404);
    assert.equal((await collect(job, "slack", { origin: APP })).status, 404);
    assert.equal((await collect(job, "slack", { origin: "http://elsewhere.test", cookie: `sid=${SID}` })).status, 403);
    assert.equal((await collect("J-999", "slack", asker)).status, 404);
    assert.equal((await collect(job, "constructor", asker)).status, 404);
    // Collecting asked no source again: each was asked once, by a board.
    assert.equal(sources.asked.length, 5);
  } finally {
    cluster.close();
    sources.server.close();
  }
});

test("a refresh from anywhere but the app's page fetches as nobody, and asks no source", async () => {
  const sources = await startSources();
  const cluster = await startCluster(4711, 3, undefined, sources.fetching);
  try {
    // The sid comes along, but not from the app's own page: another site cannot fetch as you.
    const response = await cluster.post("/api/cluster/refresh", {}, { origin: "http://elsewhere.test", cookie: `sid=${SID}` });
    const job = ((await response.json()) as { job: { id: string } }).job.id;
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");

    assert.ok(Object.values(outputs(done, job)).every((summary) => summary === "No signed-in browser asked for this refresh, so nothing was loaded"));
    assert.equal(Object.keys(outputs(done, job)).length, 5);
    assert.deepEqual(sources.asked, []);
  } finally {
    cluster.close();
    sources.server.close();
  }
});

test("a board that dies mid-fetch: another board fetches the source again and reports what it loaded", async () => {
  const sources = await startSources();
  const cluster = await startCluster(4721, 3, undefined, sources.fetching);
  try {
    const response = await cluster.post("/api/cluster/refresh", {}, { origin: APP, cookie: `sid=${SID}` });
    const job = ((await response.json()) as { job: { id: string } }).job.id;
    const busy = await cluster.until((current) => current.tasks.some((task) => task.job === job && task.source === "slack" && task.status === "claimed" && task.progress >= 0.3), "a board is partway through the Slack fetch");
    const victim = busy.tasks.find((task) => task.job === job && task.source === "slack")!;
    const board = victim.worker!;

    // SIGKILL, like pulling the power on the board mid-fetch.
    assert.equal((await cluster.post(`/api/cluster/nodes/${board}/kill`)).status, 200);
    const done = await cluster.until(cluster.jobDone(job), "the refresh is done");
    const resumed = done.tasks.find((task) => task.id === victim.id)!;

    assert.deepEqual(resumed.lostBy, [board]);
    assert.notEqual(resumed.runs.at(-1)!.worker, board);
    assert.equal(resumed.output?.summary, "Loaded 2 Slack messages");
    // The board that took it over fetched again: a read is safe to repeat.
    assert.equal(sources.asked.filter((request) => request.path === "/api/slack/messages").length, 2);
  } finally {
    cluster.close();
    sources.server.close();
  }
});
