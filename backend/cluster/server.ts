import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { rmSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The gateway between the Console and the cluster. It holds no queue of its
// own: it starts and stops the node processes, asks each node for its Raft
// status, reads the queue from whichever node is orchestrator, and passes the
// Console's requests on to the cluster.

// Six Uno Q boards, so six node names.
export const NODE_IDS = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

// The product's morning refresh: the fetches run on different nodes at the same
// time, and ranking waits for all of them.
export const REFRESH = {
  name: "Morning refresh",
  steps: ["Fetch Jira tickets", "Fetch Slack messages", "Fetch GitHub pull requests", "Fetch GitHub reviews", "Fetch Outlook mail", "Fetch Outlook calendar"],
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
  connected: boolean;
};

type QueueState = { tasks: unknown[]; jobs: Array<{ doneAt: number | null }>; workers: unknown[]; events: unknown[] };

export function createClusterServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.CLUSTER_PORT ?? 3003);
  const nodePort = Number(options.nodePort ?? process.env.CLUSTER_NODE_PORT ?? 4101);
  const dataDir = options.dataDir ?? process.env.CLUSTER_DATA ?? join(tmpdir(), "continuum-cluster");
  const nodeFile = fileURLToPath(new URL("./node.ts", import.meta.url));
  const address = (id: string) => `http://localhost:${nodePort + NODE_IDS.indexOf(id)}`;
  const peers = NODE_IDS.map((id) => `${id}=${address(id)}`).join(",");
  // Node processes this gateway started, so it can kill them.
  const children = new Map<string, ChildProcess>();
  let auto = options.auto ?? false;
  let submitting = false;

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
      for (const node of orchestrator ? [orchestrator] : nodes.filter((candidate) => candidate.connected)) {
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
    const queue: QueueState = source ? await nodeJson<QueueState>(source.id, "/state").catch(() => ({ tasks: [], jobs: [], workers: [], events: [] })) : { tasks: [], jobs: [], workers: [], events: [] };
    const members = orchestrator?.members ?? source?.members ?? [];
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
    const orchestrator = orchestratorOf(nodes);
    const members = orchestrator?.members ?? [];
    const id = NODE_IDS.find((candidate) => !members.includes(candidate) && !children.has(candidate) && !nodes.some((node) => node.id === candidate));
    if (!id) return [409, { error: `All ${NODE_IDS.length} nodes are in use.` }];
    // With nothing running at all, the new node starts a cluster of one.
    if (!nodes.length && !children.size) {
      startNode(id, { fresh: true, bootstrap: [id] });
      return [201, { id }];
    }
    if (!orchestrator) return [409, { error: "There is no orchestrator to add a node to. Restart a dead node first." }];
    startNode(id, { fresh: true });
    await clusterRequest({ members: { add: id } });
    return [201, { id }];
  }

  async function removeNode(id: string): Promise<void> {
    if (children.has(id)) {
      // The node finishes its current step, leaves the queue, then takes itself out of the members.
      await clusterRequest({ type: "leave", worker: id });
      return;
    }
    // A dead node is taken out right away.
    await clusterRequest({ members: { remove: id } });
    await clusterRequest({ type: "leave", worker: id });
    rmSync(join(dataDir, `${id}.json`), { force: true });
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

      const nodePath = url.pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/(start|kill|remove|disconnect)$/);
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
        } else if (action === "remove") {
          await removeNode(id);
        } else {
          await nodeJson(id, "/disconnect", { on: (await readBody(req)).on });
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

  return { server, port, startNode, stopNodes, clusterState };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, port, startNode, stopNodes } = createClusterServer({ auto: process.env.CLUSTER_AUTO === "1" });
  server.listen(port, () => {
    console.log(`Cluster gateway listening on http://localhost:${port}`);
    // CLUSTER_NODES=3 starts Q-01 to Q-03 as one cluster. Nodes that saved a log
    // before pick up where they were; the bootstrap list only counts for a node starting empty.
    const first = NODE_IDS.slice(0, Number(process.env.CLUSTER_NODES ?? 0));
    for (const id of first) startNode(id, { bootstrap: first });
  });
  // Take the node processes down with the gateway.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopNodes();
      process.exit(0);
    });
  }
}
