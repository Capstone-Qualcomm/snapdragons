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
// It stands in for one Uno Q board, and only talks to the others over HTTP.

type NodeOptions = {
  id: string;
  // Where every node can be reached, by name.
  peers: Record<string, string>;
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

function fileStorage(file: string) {
  return {
    load: (): Persisted | null => {
      try {
        return JSON.parse(readFileSync(file, "utf8")) as Persisted;
      } catch {
        return null;
      }
    },
    // Written to a temporary file and renamed, so a node killed mid-write keeps the old copy.
    save: (data: Persisted) => {
      writeFileSync(`${file}.tmp`, JSON.stringify(data));
      renameSync(`${file}.tmp`, file);
    },
  };
}

export function startNode({ id, peers, dataDir, bootstrap, workMs = 3000, leaseMs = 2000, heartbeatMs = 300, electionMs = [1500, 3000] }: NodeOptions) {
  const port = Number(new URL(peers[id]).port);
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
    send: (to, type, body) => post(`${peers[to]}/raft/${type}`, body, 500),
    onRemoved: () => setTimeout(() => process.exit(0), 200),
  });

  // Orchestrator only: when each node last asked for anything. This is not in the
  // log; a new orchestrator starts everyone's clock again when it takes over.
  const lastSeen = new Map<string, number>();
  let orchestratorTerm = -1;

  function checkLeases(): void {
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
      return (await post<{ result: unknown }>(`${peers[orchestrator]}/client`, body, 4000)).result;
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

  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url ?? "/", "http://localhost").pathname;
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
  // Peers and the gateway reach a node over loopback, and /client changes the members, so nothing else should. Set HOST to listen somewhere else.
  server.listen(port, process.env.HOST ?? "127.0.0.1");

  const timers = [setInterval(raft.tick, 50), setInterval(checkLeases, 250)];
  const controller = new AbortController();

  // The worker runs until a Remove; then this node takes itself out of the members and stops.
  void runWorker({ id, call: request, workMs, heartbeatMs: 500, signal: controller.signal }).then(async () => {
    while (!controller.signal.aborted) {
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

  return {
    raft,
    stop: () => {
      controller.abort();
      for (const timer of timers) clearInterval(timer);
      server.close();
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const env = process.env;
  const id = env.NODE_ID ?? process.argv[2];
  if (!id || !env.CLUSTER_PEERS) {
    console.error("Usage: NODE_ID=Q-01 CLUSTER_PEERS=Q-01=http://127.0.0.1:4101,... node node.ts");
    process.exit(1);
  }
  const ms = (name: string, fallback: number) => Number(env[name] ?? fallback);
  startNode({
    id,
    peers: Object.fromEntries(env.CLUSTER_PEERS.split(",").map((pair) => pair.split("="))),
    dataDir: env.CLUSTER_DATA ?? "data",
    bootstrap: env.CLUSTER_BOOTSTRAP?.split(","),
    workMs: ms("WORK_MS", 3000),
    leaseMs: ms("LEASE_MS", 2000),
    heartbeatMs: ms("RAFT_HEARTBEAT_MS", 300),
    electionMs: [ms("RAFT_ELECTION_MIN_MS", 1500), ms("RAFT_ELECTION_MAX_MS", 3000)],
  });
}
