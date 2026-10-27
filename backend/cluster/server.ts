import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { complete } from "./llm.ts";
import type { Message } from "./llm.ts";
import { fileStorage } from "./node.ts";
import { demoSample, serveDemo } from "./services.ts";
import type { Persisted } from "./raft.ts";
import { describeScenarios, scenarioById } from "./scenarios/index.ts";

// The gateway between the app and the cluster. It holds no queue of its
// own: it starts and stops the node processes, asks each node for its Raft
// status, reads the queue from whichever node is orchestrator, and passes the
// app's requests on to the cluster.
//
// With CLUSTER_BOARDS set it runs the real Uno Q boards instead: it starts nothing,
// finds the boards by name on their tailnet, powers them off and on rather than
// killing processes, and hands out the join script.
//
// Either way it serves the boards what they query besides each other (services.ts):
// the model, and the demo company's mail, calendar and hiring req.

// Six Uno Q boards, so six node names.
export const NODE_IDS = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

// The product's morning refresh: one fetch per source Today really loads (each
// backend's list call), run on different nodes at the same time, and ranking
// waits for all of them. A new source adds its fetch here.
export const REFRESH = {
  name: "Morning refresh",
  steps: ["Fetch Jira tickets", "Fetch Slack messages", "Fetch GitHub issues"],
  then: "Rank today's list",
};

// Auto mode waits this long after a refresh finishes before starting the next.
const AUTO_PAUSE_MS = 1500;

// How fast an Assistant plan runs: each step's time is multiplied by this.
const PACES: Record<string, number> = { slow: 1.6, normal: 1, fast: 0.5 };

type ServerOptions = {
  port?: number;
  // Real boards: the names of boards to look for first (more are found as they join).
  boards?: string[];
  // The address people and boards reach this app at, for the join script.
  appUrl?: string;
  // Q-01 listens on nodePort, Q-02 on nodePort + 1, and so on.
  nodePort?: number;
  dataDir?: string;
  auto?: boolean;
  // Passed to every node: WORK_MS, LEASE_MS and the RAFT_* timings.
  nodeEnv?: Record<string, string>;
};

type NodeStatus = {
  id: string;
  role: "worker" | "candidate" | "orchestrator";
  term: number;
  orchestrator: string | null;
  votedFor: string | null;
  votes: string[];
  members: string[];
  commitIndex: number;
  lastIndex: number;
};

type QueueState = { tasks: unknown[]; jobs: Array<{ doneAt: number | null; plan?: unknown }>; workers: unknown[]; terms: unknown[]; events: unknown[] };
const EMPTY_QUEUE: QueueState = { tasks: [], jobs: [], workers: [], terms: [], events: [] };

export function createClusterServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.CLUSTER_PORT ?? 3003);
  const nodePort = Number(options.nodePort ?? process.env.CLUSTER_NODE_PORT ?? 4101);
  const dataDir = options.dataDir ?? process.env.CLUSTER_DATA ?? join(tmpdir(), "continuum-cluster");
  const nodeFile = fileURLToPath(new URL("./node.ts", import.meta.url));
  const boards = options.boards ?? process.env.CLUSTER_BOARDS?.split(",").filter(Boolean);
  const appUrl = (options.appUrl ?? process.env.APP_URL ?? "http://localhost:5173").replace(/\/$/, "");
  // Every board name seen so far: the ones given, then each member any board reports.
  const known = new Set(boards ?? NODE_IDS);
  const ids = () => [...known];
  // A board answers from across the internet (the gateway may be an ocean away), so it gets longer.
  const statusMs = boards ? 1500 : 400;
  const address = (id: string) => (boards ? `http://${id}:${nodePort}` : `http://127.0.0.1:${nodePort + NODE_IDS.indexOf(id)}`);
  const peers = NODE_IDS.map((id) => `${id}=${address(id)}`).join(",");
  // Node processes this gateway started, so it can kill them.
  const children = new Map<string, ChildProcess>();
  let auto = options.auto ?? false;
  let submitting = false;
  // The last members and queue seen, so a cluster with every node down still shows who is missing and what they were doing.
  let lastMembers: string[] = [];
  let lastQueue = EMPTY_QUEUE;

  // fresh wipes the node's saved log, for a node joining as new. A restart keeps it.
  function startNode(id: string, { fresh = false, bootstrap }: { fresh?: boolean; bootstrap?: string[] } = {}): void {
    if (fresh) rmSync(join(dataDir, `${id}.json`), { force: true });
    // The name goes on the command line too, so ./scripts/kill-worker.sh can find the process.
    const child = spawn(process.execPath, [nodeFile, id], {
      env: { ...process.env, ...options.nodeEnv, NODE_ID: id, CLUSTER_PEERS: peers, CLUSTER_DATA: dataDir, ...(bootstrap && { CLUSTER_BOOTSTRAP: bootstrap.join(",") }) },
      stdio: "inherit",
    });
    children.set(id, child);
    child.on("exit", () => {
      if (children.get(id) === child) children.delete(id);
    });
  }

  // The members in the most up-to-date log saved here, or none for a cluster that has never run.
  // Not every log's members: a node removed while running may have stopped before hearing so.
  function savedMembers(): string[] {
    const logs = new Map<string, Persisted>();
    for (const id of NODE_IDS) {
      try {
        const saved = fileStorage(join(dataDir, `${id}.json`)).load();
        if (saved) logs.set(id, saved);
      } catch (cause) {
        // Left as it is. If that node is a member it refuses to start and says the same.
        console.error(`${(cause as Error).message}. Recovering from the other logs.`);
      }
    }
    const lastTerm = (saved: Persisted) => saved.log.at(-1)?.term ?? saved.snapshot.term;
    const lastIndex = (saved: Persisted) => saved.snapshot.index + saved.log.length;
    let newest: Persisted | undefined;
    for (const saved of logs.values()) {
      if (!newest || lastTerm(saved) > lastTerm(newest) || (lastTerm(saved) === lastTerm(newest) && lastIndex(saved) > lastIndex(newest))) newest = saved;
    }
    if (!newest) return [];
    const { snapshot } = newest;
    const configs = newest.log.flatMap((entry, offset) => (entry.command.type === "config" ? [{ index: snapshot.index + offset + 1, term: entry.term, members: entry.command.members as string[] }] : []));
    const latest = configs.at(-1);
    if (!latest) return snapshot.members;
    // A committed change is on a majority of its own members' logs. One that may not be
    // also starts the members from before it, since finishing or undoing it can need them.
    const has = (saved: Persisted | undefined) => !!saved && (latest.index <= saved.snapshot.index || saved.log[latest.index - saved.snapshot.index - 1]?.term === latest.term);
    if (latest.members.filter((id) => has(logs.get(id))).length > latest.members.length / 2) return latest.members;
    const before = configs.at(-2)?.members ?? snapshot.members;
    return NODE_IDS.filter((id) => latest.members.includes(id) || before.includes(id));
  }

  // Starts the members the saved logs name, each picking up where it was. Only a
  // cluster with nothing saved starts new, as the first `size` nodes.
  function startCluster(size: number): string[] {
    // Boards start themselves.
    if (boards) return [];
    const saved = savedMembers();
    if (saved.length) {
      for (const id of saved) if (!children.has(id)) startNode(id);
      return saved;
    }
    // No saved log names any members, so nothing is lost by starting each one empty.
    const first = NODE_IDS.slice(0, size);
    for (const id of first) startNode(id, { fresh: true, bootstrap: first });
    return first;
  }

  function stopNodes(): void {
    for (const child of children.values()) child.kill("SIGKILL");
    children.clear();
  }

  async function nodeJson<T>(id: string, path: string, body?: unknown, timeoutMs = statusMs): Promise<T> {
    const response = await fetch(address(id) + path, {
      method: body === undefined ? "GET" : "POST",
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? `${id} returned ${response.status}`);
    return data as T;
  }

  async function statuses(): Promise<NodeStatus[]> {
    const all = (await Promise.all(ids().map((id) => nodeJson<NodeStatus>(id, "/status").catch(() => null)))).filter((status): status is NodeStatus => status !== null);
    for (const status of all) for (const member of status.members) known.add(member);
    return all;
  }

  // A node cut off from the rest may still think it leads an old term, so the highest term wins.
  const orchestratorOf = (nodes: NodeStatus[]) => nodes.filter((node) => node.role === "orchestrator").sort((a, b) => b.term - a.term)[0] ?? null;

  // Sends a request into the cluster through any running node, which passes it to
  // the orchestrator. Keeps trying through an election, for a few seconds.
  async function clusterRequest(body: Record<string, unknown>, timeoutMs = 6000): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    let lastError = new Error("No node is running.");
    while (Date.now() < deadline) {
      const nodes = await statuses();
      const orchestrator = orchestratorOf(nodes);
      for (const node of orchestrator ? [orchestrator] : nodes) {
        try {
          return (await nodeJson<{ result: unknown }>(node.id, "/client", body, 5000)).result;
        } catch (cause) {
          lastError = cause as Error;
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw lastError;
  }

  async function clusterState() {
    const nodes = await statuses();
    const orchestrator = orchestratorOf(nodes);
    // Without an orchestrator, show the copy that has the most committed entries.
    const source = orchestrator ?? [...nodes].sort((a, b) => b.commitIndex - a.commitIndex)[0];
    if (source) lastQueue = await nodeJson<QueueState>(source.id, "/state").catch(() => lastQueue);
    if (source) lastMembers = orchestrator?.members ?? source.members;
    const queue = lastQueue;
    const members = lastMembers;
    const raft = ids().filter((id) => members.includes(id) || nodes.some((node) => node.id === id) || children.has(id)).map((id) => {
      const status = nodes.find((node) => node.id === id);
      return status ? { ...status, up: true, member: members.includes(id) } : { id, up: false, member: members.includes(id) };
    });
    return { ...queue, now: Date.now(), auto, maxNodes: boards ? 99 : NODE_IDS.length, orchestrator: orchestrator?.id ?? null, term: orchestrator?.term ?? null, members, nodes: raft, ...(boards && { boards: true, join: joinCommand }) };
  }

  async function autoRefresh(): Promise<void> {
    if (!auto || submitting) return;
    submitting = true;
    try {
      const { jobs, orchestrator } = await clusterState();
      // Any unfinished job holds it back, an Assistant plan included, so the boards stay on the plan.
      const running = jobs.some((job) => job.doneAt === null);
      const lastDone = Math.max(0, ...jobs.map((job) => job.doneAt ?? 0));
      if (orchestrator && !running && Date.now() - lastDone >= AUTO_PAUSE_MS) await clusterRequest({ type: "job", ...REFRESH });
    } catch {
      // No orchestrator right now. Try again on the next tick.
    } finally {
      submitting = false;
    }
  }

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  }

  async function addNode(): Promise<[number, unknown]> {
    if (boards) return [409, { error: `A board joins by itself. On the board, run: ${joinCommand}` }];
    const nodes = await statuses();
    // With nothing running at all, the saved members come back as they were. Only
    // with nothing saved does the new node start a cluster of one.
    if (!nodes.length && !children.size) return [201, { started: startCluster(1) }];
    const orchestrator = orchestratorOf(nodes);
    const members = orchestrator?.members ?? [];
    const id = NODE_IDS.find((candidate) => !members.includes(candidate) && !children.has(candidate) && !nodes.some((node) => node.id === candidate));
    if (!id) return [409, { error: `All ${NODE_IDS.length} nodes are in use.` }];
    if (!orchestrator) return [409, { error: "There is no orchestrator to add a node to. Restart a dead node first." }];
    startNode(id, { fresh: true });
    await clusterRequest({ members: { add: id } });
    return [201, { id }];
  }

  async function removeNode(id: string): Promise<[number, unknown]> {
    const last: [number, unknown] = [409, { error: "The last node cannot be removed." }];
    const nodes = await statuses();
    const members = orchestratorOf(nodes)?.members ?? [];
    if (members.length === 1 && members[0] === id) return last;
    if (boards ? nodes.some((node) => node.id === id) : children.has(id)) {
      // The node finishes its current step, leaves the queue, then takes itself out of the members.
      // The queue refuses when no other node would be left working, which also catches two removals at once.
      return (await clusterRequest({ type: "leave", worker: id })) === false ? last : [200, { id }];
    }
    // A dead node is taken out right away.
    await clusterRequest({ members: { remove: id } });
    await clusterRequest({ type: "leave", worker: id });
    if (!boards) rmSync(join(dataDir, `${id}.json`), { force: true });
    return [200, { id }];
  }

  // A board's power, from the dashboard: off is a board losing power mid-step, on is it booting back.
  const power = (id: string, on: boolean) => nodeJson(id, "/power", { on }, 3000);

  // What a new board runs, once, to join: it sets up its own tailnet container and node container.
  const joinCommand = `curl -fsSL ${appUrl}/api/cluster/join.sh | sh -s -- <your name> <tailnet auth key>`;
  const joinScript = () => readFileSync(new URL("./join.sh", import.meta.url), "utf8").replaceAll("__APP_URL__", appUrl);
  // The node's code for a board: this folder without tests or dependencies, which a node does not need.
  // The demo data stays here: boards query it from the services instead.
  const code = () => execFileSync("tar", ["-cz", "--exclude=node_modules", "--exclude=*.test.ts", "--exclude=./scenarios/data", "-C", fileURLToPath(new URL(".", import.meta.url)), "."]);

  // Every node goes down at once, then comes back from what it saved to disk.
  async function restartAll(): Promise<void> {
    if (boards) {
      const up = (await statuses()).map((node) => node.id);
      await Promise.all(up.map((id) => power(id, false).catch(() => {})));
      setTimeout(() => up.forEach((id) => power(id, true).catch(() => {})), 1500);
      return;
    }
    const ids = [...children.keys()];
    stopNodes();
    setTimeout(() => {
      for (const id of ids) startNode(id);
    }, 1500);
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
      const post = req.method === "POST";

      if (req.method === "GET" && url.pathname === "/api/cluster/state") return send(res, 200, await clusterState());
      if (req.method === "GET" && url.pathname === "/api/cluster/join.sh") {
        res.writeHead(200, { "Content-Type": "text/x-shellscript; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(joinScript());
      }
      if (req.method === "GET" && url.pathname === "/api/cluster/code.tgz") {
        res.writeHead(200, { "Content-Type": "application/gzip", "Cache-Control": "no-store" });
        return res.end(code());
      }
      if (post && url.pathname === "/api/cluster/refresh") return send(res, 201, { job: await clusterRequest({ type: "job", ...REFRESH }) });
      if (req.method === "GET" && url.pathname === "/api/assistant/scenarios") return send(res, 200, { scenarios: describeScenarios() });
      const sample = url.pathname.match(/^\/api\/assistant\/scenarios\/([^/]+)\/sample$/);
      if (req.method === "GET" && sample) {
        const scenario = scenarioById(sample[1]);
        return scenario?.sample ? send(res, 200, demoSample()) : send(res, 404, { error: "That scenario has no demo data to show." });
      }
      if (post && url.pathname === "/api/assistant/run") {
        const body = await readBody(req);
        const scenario = scenarioById(String(body.scenario ?? ""));
        if (!scenario) return send(res, 400, { error: "Pick one of the demo scenarios." });
        const prompt = typeof body.prompt === "string" && body.prompt.trim() ? body.prompt.trim().slice(0, 500) : scenario.prompt;
        const pace = PACES[String(body.pace)] ?? 1;
        return send(res, 201, { job: await clusterRequest({ type: "plan", scenario: scenario.id, prompt, pace }) });
      }
      if (post && url.pathname === "/api/assistant/stop") {
        const job = await clusterRequest({ type: "cancel", job: String((await readBody(req)).job ?? "") });
        return job ? send(res, 200, { job }) : send(res, 409, { error: "That job is not running." });
      }
      if (post && url.pathname === "/api/cluster/auto") {
        auto = Boolean((await readBody(req)).on);
        return send(res, 200, { auto });
      }
      if (post && url.pathname === "/api/cluster/nodes") {
        const [status, data] = await addNode();
        return send(res, status, data);
      }
      if (post && url.pathname === "/api/cluster/restart") {
        await restartAll();
        return send(res, 200, { ok: true });
      }

      const nodePath = url.pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/(start|kill|remove)$/);
      if (post && nodePath) {
        const [, id, action] = nodePath;
        if (!known.has(id)) return send(res, 404, { error: "No such node." });
        if (boards && action !== "remove") {
          await power(id, action === "start");
          return send(res, 200, { id });
        }
        if (action === "start") {
          if (children.has(id)) return send(res, 409, { error: `${id} is already running.` });
          startNode(id);
        } else if (action === "kill") {
          const child = children.get(id);
          if (!child) return send(res, 409, { error: `${id} is not running.` });
          // SIGKILL, like a board losing power: no cleanup, no goodbye to the cluster.
          child.kill("SIGKILL");
          children.delete(id);
        } else {
          const [status, data] = await removeNode(id);
          return send(res, status, data);
        }
        return send(res, 200, { id });
      }

      send(res, 404, { error: "Not found." });
    } catch (cause) {
      if (cause instanceof SyntaxError) send(res, 400, { error: "Request body must be valid JSON." });
      else send(res, 503, { error: cause instanceof Error ? cause.message : "Cluster unavailable." });
    }
  });

  const autoTimer = setInterval(autoRefresh, 1000);
  server.on("close", () => {
    clearInterval(autoTimer);
    stopNodes();
  });

  // What every node can query: the model (boards have no key) and the demo company's systems.
  // On real boards it listens on the tailnet only; on one laptop, on loopback.
  const servicesServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      if (req.method === "GET" && serveDemo(url.pathname, url.searchParams, send, res)) return;
      if (req.method !== "POST" || url.pathname !== "/llm") return send(res, 404, { error: "Not found." });
      const { messages, maxTokens, stream } = (await readBody(req)) as { messages: Message[]; maxTokens?: number; stream?: boolean };
      const tokens = Math.min(Number(maxTokens) || 800, 3000);
      if (!stream) return send(res, 200, { text: await complete(messages, tokens) });
      // Passed on as plain text as it comes, so the board can show the draft being written.
      let sent = 0;
      await complete(messages, tokens, (text) => {
        if (!res.headersSent) res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
        res.write(text.slice(sent));
        sent = text.length;
      });
      res.end();
    } catch (cause) {
      if (res.headersSent) return void res.end();
      send(res, 502, { error: cause instanceof Error ? cause.message : "The model call failed." });
    }
  });

  return { server, servicesServer, port, startNode, startCluster, stopNodes, clusterState };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  // Real boards start with auto refresh off, so they are not busy all night; the page can turn it on.
  const { server, servicesServer, port, startCluster, stopNodes } = createClusterServer({ auto: process.env.CLUSTER_AUTO === "1" && !process.env.CLUSTER_BOARDS });
  // Real boards reach the services on this gateway's tailnet address; the nodes it starts itself, on loopback.
  const servicesPort = Number(process.env.CLUSTER_SERVICES_PORT ?? 4100);
  // A busy port (a second gateway on one machine) leaves this one without services rather than down.
  servicesServer.on("error", (cause) => console.error(`Services not started on port ${servicesPort}: ${cause.message}`));
  servicesServer.listen(servicesPort, process.env.CLUSTER_BOARDS ? "0.0.0.0" : "127.0.0.1");
  process.env.SERVICES_URL ??= `http://127.0.0.1:${servicesPort}`;
  // The gateway can kill nodes and has no login, so it stays on loopback. Set HOST to listen somewhere else.
  const host = process.env.HOST ?? "127.0.0.1";
  server.listen(port, host, () => {
    console.log(`Cluster gateway listening on http://${host}:${port}`);
    // CLUSTER_NODES=3 starts Q-01 to Q-03 as a new cluster. A cluster that saved
    // its logs before comes back with the members it had, however many that is.
    startCluster(Number(process.env.CLUSTER_NODES ?? 0));
  });
  // Take the node processes down with the gateway.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopNodes();
      process.exit(0);
    });
  }
}
