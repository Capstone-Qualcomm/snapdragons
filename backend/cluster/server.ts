import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fileStorage } from "./node.ts";
import type { Persisted } from "./raft.ts";

// The gateway between the app and the cluster. It holds no queue of its
// own: it starts and stops the node processes, asks each node for its Raft
// status, reads the queue from whichever node is orchestrator, and passes the
// app's requests on to the cluster.

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

type ServerOptions = {
  port?: number;
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

type QueueState = { tasks: unknown[]; jobs: Array<{ doneAt: number | null }>; workers: unknown[]; terms: unknown[]; events: unknown[] };
const EMPTY_QUEUE: QueueState = { tasks: [], jobs: [], workers: [], terms: [], events: [] };

export function createClusterServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.CLUSTER_PORT ?? 3003);
  const nodePort = Number(options.nodePort ?? process.env.CLUSTER_NODE_PORT ?? 4101);
  const dataDir = options.dataDir ?? process.env.CLUSTER_DATA ?? join(tmpdir(), "continuum-cluster");
  const nodeFile = fileURLToPath(new URL("./node.ts", import.meta.url));
  const address = (id: string) => `http://127.0.0.1:${nodePort + NODE_IDS.indexOf(id)}`;
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

  async function nodeJson<T>(id: string, path: string, body?: unknown, timeoutMs = 400): Promise<T> {
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
    const all = await Promise.all(NODE_IDS.map((id) => nodeJson<NodeStatus>(id, "/status").catch(() => null)));
    return all.filter((status): status is NodeStatus => status !== null);
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
    const raft = NODE_IDS.filter((id) => members.includes(id) || nodes.some((node) => node.id === id) || children.has(id)).map((id) => {
      const status = nodes.find((node) => node.id === id);
      return status ? { ...status, up: true, member: members.includes(id) } : { id, up: false, member: members.includes(id) };
    });
    return { ...queue, now: Date.now(), auto, maxNodes: NODE_IDS.length, orchestrator: orchestrator?.id ?? null, term: orchestrator?.term ?? null, members, nodes: raft };
  }

  async function autoRefresh(): Promise<void> {
    if (!auto || submitting) return;
    submitting = true;
    try {
      const { jobs, orchestrator } = await clusterState();
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
    // The orchestrator refuses this too, but only after the node has left the queue.
    const members = orchestratorOf(await statuses())?.members ?? [];
    if (members.length === 1 && members[0] === id) return [409, { error: "The last node cannot be removed." }];
    if (children.has(id)) {
      // The node finishes its current step, leaves the queue, then takes itself out of the members.
      await clusterRequest({ type: "leave", worker: id });
      return [200, { id }];
    }
    // A dead node is taken out right away.
    await clusterRequest({ members: { remove: id } });
    await clusterRequest({ type: "leave", worker: id });
    rmSync(join(dataDir, `${id}.json`), { force: true });
    return [200, { id }];
  }

  // Every node goes down at once, then comes back from what it saved to disk.
  function restartAll(): void {
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
      if (post && url.pathname === "/api/cluster/refresh") return send(res, 201, { job: await clusterRequest({ type: "job", ...REFRESH }) });
      if (post && url.pathname === "/api/cluster/auto") {
        auto = Boolean((await readBody(req)).on);
        return send(res, 200, { auto });
      }
      if (post && url.pathname === "/api/cluster/nodes") {
        const [status, data] = await addNode();
        return send(res, status, data);
      }
      if (post && url.pathname === "/api/cluster/restart") {
        restartAll();
        return send(res, 200, { ok: true });
      }

      const nodePath = url.pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/(start|kill|remove)$/);
      if (post && nodePath) {
        const [, id, action] = nodePath;
        if (!NODE_IDS.includes(id)) return send(res, 404, { error: "No such node." });
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

  return { server, port, startNode, startCluster, stopNodes, clusterState };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, port, startCluster, stopNodes } = createClusterServer({ auto: process.env.CLUSTER_AUTO === "1" });
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
