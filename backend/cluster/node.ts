import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createQueue } from "./queue.ts";
import { NotOrchestrator, createRaft } from "./raft.ts";
import type { Command, Persisted } from "./raft.ts";
import { runWorker } from "./worker.ts";

// One node is one process: a Raft peer, its copy of the queue, and a worker.
// It stands in for one Uno Q board, or runs on one, and only talks to the others over HTTP.

type NodeOptions = {
  id: string;
  // Where nodes can be reached, by name. A name missing here is reached as http://<name>:<port>,
  // which on the boards' tailnet is the board itself.
  peers: Record<string, string>;
  port?: number;
  // 127.0.0.1 on one laptop; on a board, every address in its network, which is only its tailnet.
  host?: string;
  // Members of a running cluster to ask for a place in it, for a node starting with nothing saved.
  join?: string[];
  dataDir: string;
  bootstrap?: string[];
  workMs?: number;
  // How long the orchestrator waits without hearing from a node before handing its step to another.
  leaseMs?: number;
  heartbeatMs?: number;
  electionMs?: [number, number];
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export function fileStorage(file: string) {
  return {
    // Only a missing file means a new node. A damaged one stops the node instead of being replaced by an empty log.
    load: (): Persisted | null => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Persisted;
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw new Error(`Cannot read the saved log ${file}: ${(cause as Error).message}`);
      }
    },
    // Written to a temporary file and renamed, so a node killed mid-write keeps the old copy.
    save: (data: Persisted) => {
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    },
  };
}

export function startNode({ id, peers, port: givenPort, host = "127.0.0.1", join: seeds = [], dataDir, bootstrap, workMs = 3000, leaseMs = 2000, heartbeatMs = 300, electionMs = [1500, 3000] }: NodeOptions) {
  const port = givenPort ?? Number(new URL(peers[id]).port);
  const peer = (name: string) => peers[name] ?? `http://${name}:${port}`;
  mkdirSync(dataDir, { recursive: true });
  const queue = createQueue();

  async function post<T>(url: string, body: unknown, timeoutMs: number): Promise<T> {
    const response = await fetch(url, { method: "POST", body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
    const data = await response.json();
    if (!response.ok) throw new HttpError(response.status, data.error ?? `${url} returned ${response.status}`);
    return data as T;
  }

  const raft = createRaft({
    id,
    bootstrap,
    machine: queue,
    storage: fileStorage(join(dataDir, `${id}.json`)),
    heartbeatMs,
    electionMs,
    send: (to, type, body) => post(`${peer(to)}/raft/${type}`, body, 500),
    onRemoved: () => setTimeout(() => process.exit(0), 200),
  });

  // Orchestrator only: when each node last asked for anything. This is not in the
  // log; a new orchestrator starts everyone's clock again when it takes over.
  const lastSeen = new Map<string, number>();
  let orchestratorTerm = -1;

  function checkLeases(): void {
    if (off) return;
    const { role, term } = raft.status();
    if (role !== "orchestrator") return;
    if (term !== orchestratorTerm) {
      orchestratorTerm = term;
      lastSeen.clear();
    }
    for (const worker of queue.state().workers) {
      if (!lastSeen.has(worker.id)) lastSeen.set(worker.id, Date.now());
      if (!worker.alive || Date.now() - lastSeen.get(worker.id)! <= leaseMs) continue;
      lastSeen.set(worker.id, Infinity);
      raft.submit({ type: "expire", worker: worker.id, at: Date.now() }).catch(() => lastSeen.delete(worker.id));
    }
  }

  // Every queue change goes through the orchestrator. Any other node passes it on.
  async function request(body: Record<string, unknown>): Promise<unknown> {
    if (!raft.isOrchestrator()) {
      const { orchestrator } = raft.status();
      if (!orchestrator || orchestrator === id) throw new HttpError(503, new NotOrchestrator(null).message);
      return (await post<{ result: unknown }>(`${peer(orchestrator)}/client`, body, 4000)).result;
    }
    if (body.members) return raft.changeMembers(body.members as { add?: string; remove?: string });
    const command = { ...body, at: Date.now() } as unknown as Command;
    if (typeof command.worker === "string") {
      lastSeen.set(command.worker, Date.now());
      if (command.type === "claim" && !queue.claimChangesState(command.worker)) return { task: null };
    }
    return raft.submit(command);
  }

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    res.end(JSON.stringify(data));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    return JSON.parse(raw || "{}");
  }

  // Powered off from the dashboard: the board stops answering and stops working, like losing power,
  // but keeps what it saved, so powering on is the same as a reboot.
  let off = false;

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
      if (path === "/power" && req.method === "POST") {
        const on = Boolean((await readBody(req)).on);
        if (on && off) startWorker();
        if (!on && !off) worker.abort();
        off = !on;
        return send(res, 200, { on });
      }
      // A board without power does not answer at all, so callers time out as they would.
      if (off) return void req.socket.destroy();
      // The gateway reads these to draw the cluster.
      if (path === "/status") return send(res, 200, raft.status());
      if (path === "/state") return send(res, 200, queue.state());
      if (path === "/raft/vote") return send(res, 200, raft.handleVote((await readBody(req)) as never));
      if (path === "/raft/append") return send(res, 200, raft.handleAppend((await readBody(req)) as never));
      if (path === "/client") return send(res, 200, { result: await request(await readBody(req)) });
      send(res, 404, { error: "Not found." });
    } catch (cause) {
      const status = cause instanceof HttpError ? cause.status : cause instanceof NotOrchestrator ? 503 : 500;
      send(res, status, { error: cause instanceof Error ? cause.message : "Node error." });
    }
  });
  // /client changes the members and /power turns the board off, so only peers and the gateway may reach a node:
  // loopback on one laptop, the boards' tailnet on a board (its container has no other network).
  server.listen(port, host);

  const timers = [setInterval(() => off || raft.tick(), 50), setInterval(checkLeases, 250)];
  let worker = new AbortController();
  let stopped = false;

  // The worker runs until a Remove; then this node takes itself out of the members and stops.
  // Powering off aborts it mid-step, so its step goes back to the queue as a crash would.
  function startWorker(): void {
    const controller = (worker = new AbortController());
    // A board without power sends nothing, not even the heartbeats of a step it was on.
    const call = (body: Record<string, unknown>) => (off ? Promise.reject(new Error("Powered off.")) : request(body));
    void runWorker({ id, call, workMs, heartbeatMs: 500, signal: controller.signal }).then(async () => {
      if (controller.signal.aborted) return;
      while (!stopped) {
        try {
          await request({ members: { remove: id } });
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      // The orchestrator removing itself exits once the change commits (onRemoved).
      if (!raft.isOrchestrator()) process.exit(0);
    });
  }
  startWorker();

  // A new board asks the cluster's members for a place, until the orchestrator has added it.
  void (async () => {
    const others = seeds.filter((seed) => seed !== id);
    while (!stopped && others.length && !raft.status().members.length) {
      for (const seed of others) {
        try {
          await post(`${peer(seed)}/client`, { members: { add: id } }, 4000);
          return;
        } catch {
          // That member is down, or another board is joining. Ask the next one.
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();

  return {
    raft,
    stop: () => {
      stopped = true;
      worker.abort();
      for (const timer of timers) clearInterval(timer);
      server.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const id = env.NODE_ID ?? process.argv[2];
  if (!id || !(env.CLUSTER_PEERS || env.NODE_PORT)) {
    console.error("Usage: NODE_ID=Q-01 CLUSTER_PEERS=Q-01=http://127.0.0.1:4101,... node node.ts\n   or, on a board: NODE_ID=q-name NODE_PORT=4101 NODE_HOST=0.0.0.0 CLUSTER_JOIN_URL=<app>/api/cluster/join node node.ts");
    process.exit(1);
  }
  const ms = (name: string, fallback: number) => Number(env[name] ?? fallback);
  const list = (value?: string) => (value ? value.split(",").filter(Boolean) : undefined);
  const dataDir = env.CLUSTER_DATA ?? "data";
  // A board starting with nothing saved asks the gateway where to go: the cluster's members to
  // join, or, when there is no cluster yet and it asked first, to start one. A board with a saved log rejoins as it was.
  let seeds = list(env.CLUSTER_JOIN);
  let bootstrap = list(env.CLUSTER_BOOTSTRAP);
  if (env.CLUSTER_JOIN_URL && !fileStorage(join(dataDir, `${id}.json`)).load()) {
    for (;;) {
      try {
        const target = (await (await fetch(`${env.CLUSTER_JOIN_URL}?id=${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(10_000) })).json()) as { join?: string[]; bootstrap?: boolean };
        if (target.bootstrap) bootstrap = [id];
        else if (target.join?.length) seeds = target.join;
        else throw new Error("no answer");
        break;
      } catch (cause) {
        console.error(`Cannot reach ${env.CLUSTER_JOIN_URL} (${(cause as Error).message}). Trying again.`);
        await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
    console.log(bootstrap ? `${id} starts a new cluster.` : `${id} joins ${seeds!.join(", ")}.`);
  }
  startNode({
    id,
    peers: Object.fromEntries((env.CLUSTER_PEERS ?? "").split(",").filter(Boolean).map((pair) => pair.split("="))),
    port: env.NODE_PORT ? Number(env.NODE_PORT) : undefined,
    host: env.NODE_HOST,
    join: seeds,
    dataDir,
    bootstrap,
    workMs: ms("WORK_MS", 3000),
    leaseMs: ms("LEASE_MS", 2000),
    heartbeatMs: ms("RAFT_HEARTBEAT_MS", 300),
    electionMs: [ms("RAFT_ELECTION_MIN_MS", 1500), ms("RAFT_ELECTION_MAX_MS", 3000)],
  });
}
