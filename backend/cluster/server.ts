import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { pathToFileURL } from "node:url";
import { createQueue } from "./queue.ts";

type ServerOptions = { port?: number; leaseMs?: number };

export function createClusterServer(options: ServerOptions = {}) {
  const port = Number(options.port ?? process.env.CLUSTER_PORT ?? 3003);
  const queue = createQueue({ leaseMs: Number(options.leaseMs ?? process.env.LEASE_MS ?? 2000) });

  function send(res: ServerResponse, status: number, data: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify(data));
  }

  async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body: unknown = JSON.parse(raw || "{}");
    if (typeof body !== "object" || body === null) throw new SyntaxError("Body must be a JSON object.");
    return body as Record<string, unknown>;
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

      if (req.method === "GET" && url.pathname === "/api/cluster/state") {
        send(res, 200, queue.state());
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/tasks") {
        const { input } = await readBody(req);
        if (typeof input !== "string" || !input) {
          send(res, 400, { error: "input is required." });
          return;
        }
        send(res, 201, { task: queue.add(input) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/claim") {
        const { worker } = await readBody(req);
        if (typeof worker !== "string" || !worker) {
          send(res, 400, { error: "worker is required." });
          return;
        }
        // task is null when the queue is empty, so the worker knows to wait and ask again.
        send(res, 200, { task: queue.claim(worker) });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/cluster/heartbeat") {
        const { worker } = await readBody(req);
        if (typeof worker !== "string" || !worker) {
          send(res, 400, { error: "worker is required." });
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
      else send(res, 500, { error: "Cluster server error." });
    }
  });

  return { server, port };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const { server, port } = createClusterServer();
  server.listen(port, () => console.log(`Cluster queue listening on http://localhost:${port}`));
}
