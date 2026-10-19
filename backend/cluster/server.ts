import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createQueue } from "./queue.ts";

type ServerOptions = { port?: number; leaseMs?: number; workMs?: number };

// The Console runs on a public URL and anyone can press its buttons, so the
// node names are fixed and there are never more worker processes than these.
export const NODE_IDS = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];
// Tasks waiting or running at once. Past this, new tasks and jobs are turned away.
const MAX_PENDING = 30;
const MAX_STEPS = 8;
// Longest task input, job name or step name, and the largest request body.
const MAX_TEXT = 80;
const MAX_BODY = 4096;

function isText(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== "" && value.length <= MAX_TEXT;
}

function isNode(value: unknown): value is string {
  return typeof value === "string" && NODE_IDS.includes(value);
}

export function createClusterServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.CLUSTER_PORT ?? 3003);
  const queue = createQueue({ leaseMs: Number(options.leaseMs ?? process.env.LEASE_MS ?? 2000) });
  // Slow enough by default to kill a node on the Console while it works on a step.
  const workMs = Number(options.workMs ?? process.env.WORK_MS ?? 4000);
  // Worker processes this server started, so it can kill them. It never kills anything else.
  const children = new Map<string, ChildProcess>();
  const workerFile = fileURLToPath(new URL("./worker.ts", import.meta.url));
  let nextJob = 1;

  function isUp(id: string): boolean {
    return children.has(id) || queue.state().workers.some((worker) => worker.id === id && worker.alive);
  }

  // The name goes on the command line too, so ./scripts/kill-worker.sh can find the process.
  function startNode(id: string): void {
    const { port: listening } = server.address() as AddressInfo;
    const child = spawn(process.execPath, [workerFile, id], {
      env: { ...process.env, WORKER_ID: id, CLUSTER_URL: `http://localhost:${listening}`, WORK_MS: String(workMs) },
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

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > MAX_BODY) throw new RangeError("Request body is too large.");
    }
    const body: unknown = JSON.parse(raw || "{}");
    if (typeof body !== "object" || body === null) throw new SyntaxError("Body must be a JSON object.");
    return body as Record<string, unknown>;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/cluster/state") {
        send(res, 200, { ...queue.state(), maxNodes: NODE_IDS.length });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/tasks") {
        const { input } = await readBody(req);
        if (typeof input !== "string" || !input) {
          send(res, 400, { error: "input is required." });
          return;
        }
        if (input.length > MAX_TEXT) {
          send(res, 400, { error: `input can be at most ${MAX_TEXT} characters.` });
          return;
        }
        if (queue.pending() >= MAX_PENDING) {
          send(res, 429, { error: `The queue is full (${MAX_PENDING} tasks). Wait for some to finish.` });
          return;
        }
        send(res, 201, { task: queue.add(input) });
        return;
      }

      // A job is split into steps that different nodes pick up at the same time.
      // "then" is an optional last step that waits for all the others.
      if (req.method === "POST" && url.pathname === "/api/cluster/jobs") {
        const { name, steps, then } = await readBody(req);
        if (!isText(name) || !Array.isArray(steps) || !steps.length || steps.length > MAX_STEPS || !steps.every(isText) || (then !== undefined && !isText(then))) {
          send(res, 400, { error: `name and 1 to ${MAX_STEPS} steps are required, each at most ${MAX_TEXT} characters.` });
          return;
        }
        if (queue.pending() + steps.length + (then ? 1 : 0) > MAX_PENDING) {
          send(res, 429, { error: `The queue is full (${MAX_PENDING} tasks). Wait for some to finish.` });
          return;
        }
        const job = { id: `J-${nextJob++}`, name };
        const tasks = steps.map((step) => queue.add(step, job));
        if (then) tasks.push(queue.add(then, job, tasks.map((task) => task.id)));
        queue.log(`${job.id} ${name} queued as ${tasks.length} steps`);
        send(res, 201, { job, tasks });
        return;
      }

      // Starts the first node name not in use yet.
      if (req.method === "POST" && url.pathname === "/api/cluster/nodes") {
        const known = new Set([...children.keys(), ...queue.state().workers.map((worker) => worker.id)]);
        const id = NODE_IDS.find((candidate) => !known.has(candidate));
        if (!id) {
          send(res, 409, { error: `All ${NODE_IDS.length} nodes are in use. Restart a dead one instead.` });
          return;
        }
        startNode(id);
        send(res, 201, { id });
        return;
      }

      const nodePath = url.pathname.match(/^\/api\/cluster\/nodes\/([^/]+)\/(start|kill)$/);
      if (req.method === "POST" && nodePath) {
        const [, id, action] = nodePath;
        if (!isNode(id)) {
          send(res, 404, { error: "No such node." });
          return;
        }
        if (action === "start") {
          if (isUp(id)) {
            send(res, 409, { error: `${id} is already running.` });
            return;
          }
          startNode(id);
          send(res, 200, { id });
          return;
        }
        const child = children.get(id);
        if (!child) {
          send(res, 409, { error: `${id} was not started by the queue server, so it cannot be killed from here.` });
          return;
        }
        // SIGKILL, like a board losing power: no cleanup, no goodbye to the queue.
        // The queue only finds out when the heartbeats stop and the lease runs out.
        child.kill("SIGKILL");
        children.delete(id);
        queue.log(`${id} killed`);
        send(res, 200, { id });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/claim") {
        const { worker } = await readBody(req);
        if (!isNode(worker)) {
          send(res, 400, { error: `worker must be one of ${NODE_IDS.join(", ")}.` });
          return;
        }
        // task is null when the queue is empty, so the worker knows to wait and ask again.
        send(res, 200, { task: queue.claim(worker) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/heartbeat") {
        const { worker } = await readBody(req);
        if (!isNode(worker)) {
          send(res, 400, { error: `worker must be one of ${NODE_IDS.join(", ")}.` });
          return;
        }
        queue.heartbeat(worker);
        send(res, 200, { ok: true });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/complete") {
        const { id, worker, result } = await readBody(req);
        if (typeof id !== "string" || typeof worker !== "string" || typeof result !== "string") {
          send(res, 400, { error: "id, worker and result are required." });
          return;
        }
        const task = queue.complete(id, worker, result);
        if (!task) {
          send(res, 409, { error: `${id} is not claimed by ${worker}.` });
          return;
        }
        send(res, 200, { task });
        return;
      }

      send(res, 404, { error: "Not found." });
    } catch (cause) {
      if (cause instanceof SyntaxError) send(res, 400, { error: "Request body must be valid JSON." });
      else if (cause instanceof RangeError) send(res, 413, { error: cause.message });
      else send(res, 500, { error: "Cluster server error." });
    }
  });

  server.on("close", stopNodes);

  return { server, port, startNode, stopNodes };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, port, startNode, stopNodes } = createClusterServer();
  server.listen(port, () => {
    console.log(`Cluster queue listening on http://localhost:${port}`);
    // CLUSTER_NODES=3 starts Q-01 to Q-03 as child processes, so the Console can kill and restart them.
    for (const id of NODE_IDS.slice(0, Number(process.env.CLUSTER_NODES ?? 0))) startNode(id);
  });
  // Take the worker processes down with the queue.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stopNodes();
      process.exit(0);
    });
  }
}
