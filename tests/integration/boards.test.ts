// The refresh on boards as they really run. Each board is the container join.sh starts on an Uno Q:
// its image, command, restart policy and every setting are read from join.sh itself, and it runs the
// code the gateway hands boards at /api/cluster/code.tgz. The gateway runs in boards mode
// (CLUSTER_BOARDS) and finds them by name. Tailscale is the one stand-in: a network with tailnet
// addresses (100.64.0.0/10, which the services check) and about 200 ms a round trip. Pulling a
// board's power is docker kill. Needs Docker; run on its own: node --test tests/integration/boards.test.ts
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const BOARDS = ["q-ann", "q-bo", "q-cy"];
const GATEWAY = "http://127.0.0.1:13003";
const APP = "http://localhost:5173";
const SID = "ab".repeat(32);
const PROJECT = "snapdragons-boards-test";
const work = mkdtempSync(join(tmpdir(), "boards-test-"));
const composeFile = join(work, "compose.yaml");
// This machine's own architecture. An Uno Q is arm64; the code is plain JavaScript, so x86 runs it the same.
const platform = `linux/${process.arch === "arm64" ? "arm64" : "amd64"}`;

// The node service join.sh writes on a board, with $ID and $APP as it fills them in.
function boardService(id: string) {
  const script = readFileSync(join(ROOT, "backend/cluster/join.sh"), "utf8").replaceAll("\r\n", "\n");
  const node = script.split("cat > compose.yaml <<EOF")[1].split("\nEOF")[0].split("\n  node:\n")[1].split("\nvolumes:")[0];
  const field = (name: string) => node.match(new RegExp(`^ {4}${name}: (.+)$`, "m"))![1];
  const environment = Object.fromEntries([...node.matchAll(/^ {6}([A-Z_]+): "?([^"\n]*?)"?$/gm)].map(([, key, value]) => [key, value]));
  // The board's tailnet names the gateway's machine; here the gateway is "gateway", and the app's
  // address ($APP) is its Caddy.
  environment.NODE_ID = id;
  environment.CLUSTER_JOIN_URL = environment.CLUSTER_JOIN_URL.replace("$APP", "http://gateway:8080");
  environment.SERVICES_URL = environment.SERVICES_URL.replace(/\/\/[^:]+:/, "//gateway:");
  return { image: field("image"), platform, command: field("command"), working_dir: field("working_dir"), restart: field("restart"), environment };
}

// Source backends on the gateway's own machine, as deploy/start.sh runs them, with Caddy in front: each
// serves its list only to the browser with SID. Slack takes 4 s, like reading every DM, so a board can
// lose power mid-fetch.
const sources = `
import { createServer, request } from "node:http";
const lists = {
  3001: ["/api/jira/issues", "issues", [{ key: "QT1S-46" }, { key: "QT1S-10" }, { key: "QT1S-53" }]],
  3002: ["/api/slack/messages", "messages", [{ text: "Can you review my PR?" }, { text: "Demo is at 2" }]],
  3004: ["/api/github/issues", "issues", [{ title: "Snapshot the queue" }]],
  3005: ["/api/outlook/messages", "messages", null],
  3006: ["/api/teams/messages", "messages", [{ text: "Standup moved to 10" }]],
};
const asked = [];
for (const [port, [path, key, list]] of Object.entries(lists)) {
  createServer(async (req, res) => {
    const sid = req.headers.cookie?.match(/sid=([0-9a-f]{64})/)?.[1] ?? null;
    asked.push({ path: req.url, sid });
    if (port === "3002") await new Promise((resolve) => setTimeout(resolve, 4000));
    const ok = req.url === path && sid === "${SID}" && list;
    res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ok ? { [key]: list } : { error: "Outlook is not connected. Connect Outlook." }));
  }).listen(Number(port), "127.0.0.1");
}
createServer((_req, res) => res.end(JSON.stringify(asked))).listen(3099, "0.0.0.0");
// Caddy, as deploy/Caddyfile has it: the gateway listens on loopback and the browser reaches it through this.
createServer((req, res) => req.pipe(request({ host: "127.0.0.1", port: 3003, path: req.url, method: req.method, headers: req.headers }, (answer) => {
  res.writeHead(answer.statusCode, answer.headers);
  answer.pipe(res);
}).on("error", () => res.writeHead(502).end()))).listen(8080, "0.0.0.0");
`;

// About 100 ms each way on every machine's tailnet link.
const latency = (of: string) => ({
  build: { context: ".", dockerfile_inline: "FROM alpine:3.20\nRUN apk add --no-cache iproute2-tc" },
  network_mode: `service:${of}`,
  cap_add: ["NET_ADMIN"],
  command: ["sh", "-c", "tc qdisc replace dev eth0 root netem delay 100ms 25ms && exec tail -f /dev/null"],
});

function compose() {
  const services: Record<string, unknown> = {
    gateway: {
      image: "node:24-slim",
      platform,
      working_dir: "/repo/backend/cluster",
      command: "node server.ts",
      environment: { CLUSTER_BOARDS: BOARDS.join(","), APP_URL: APP, CLUSTER_DATA: "/data" },
      volumes: [`${ROOT}:/repo:ro`],
      ports: ["127.0.0.1:13003:8080", "127.0.0.1:13099:3099"],
      networks: { tailnet: { ipv4_address: "100.64.0.10" } },
    },
    sources: { image: "node:24-slim", platform, command: "node /work/sources.mjs", volumes: [`${work}:/work:ro`], network_mode: "service:gateway" },
    "gateway-link": latency("gateway"),
  };
  for (const id of BOARDS) {
    services[id] = { ...boardService(id), volumes: [`${join(work, "code")}:/code:ro`, `${id}-data:/data`], networks: ["tailnet"] };
    services[`${id}-link`] = latency(id);
  }
  return {
    services,
    networks: { tailnet: { ipam: { config: [{ subnet: "100.64.0.0/24" }] } } },
    volumes: Object.fromEntries(BOARDS.map((id) => [`${id}-data`, {}])),
  };
}

const docker = (...args: string[]) => execFileSync("docker", ["compose", "-p", PROJECT, "-f", composeFile, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

type State = {
  orchestrator: string | null;
  members: string[];
  nodes: Array<{ id: string; up: boolean }>;
  tasks: Array<{ id: string; job: string; source?: string; status: string; worker: string | null; lostBy: string[]; runs: Array<{ worker: string }>; output?: { summary: string } | null }>;
  jobs: Array<{ id: string; queuedAt: number; doneAt: number | null }>;
};
const state = async () => (await (await fetch(`${GATEWAY}/api/cluster/state`)).json()) as State;
async function until(check: (current: State) => boolean, what: string, seconds = 120): Promise<State> {
  for (const deadline = Date.now() + seconds * 1000; Date.now() < deadline; await sleep(500)) {
    const current = await state().catch(() => null);
    if (current && check(current)) return current;
  }
  throw new Error(`Timed out waiting until ${what}.`);
}
const post = (path: string, headers: Record<string, string>) => fetch(GATEWAY + path, { method: "POST", body: "{}", headers });
const asker = { origin: APP, cookie: `sid=${SID}` };
const allUp = (current: State) => current.orchestrator !== null && BOARDS.every((id) => current.members.includes(id) && current.nodes.some((node) => node.id === id && node.up));
async function refresh(): Promise<string> {
  const response = await post("/api/cluster/refresh", asker);
  assert.equal(response.status, 201);
  return ((await response.json()) as { job: { id: string } }).job.id;
}
const outputs = (current: State, job: string) => Object.fromEntries(current.tasks.filter((task) => task.job === job && task.source).map((task) => [task.source, task.output?.summary]));
const asked = async () => (await (await fetch("http://127.0.0.1:13099")).json()) as Array<{ path: string; sid: string | null }>;

before(async () => {
  writeFileSync(join(work, "sources.mjs"), sources);
  writeFileSync(composeFile, JSON.stringify(compose(), null, 2));
  docker("down", "-v", "--remove-orphans");
  docker("up", "-d", "--build", "gateway", "sources", "gateway-link");
  // A board downloads its code from the gateway, so these boards run what that download holds.
  for (let attempt = 0; ; attempt++) {
    const response = await fetch(`${GATEWAY}/api/cluster/code.tgz`).catch(() => null);
    if (response?.ok) {
      writeFileSync(join(work, "code.tgz"), Buffer.from(await response.arrayBuffer()));
      break;
    }
    if (attempt > 60) throw new Error("The gateway never served the boards' code.");
    await sleep(500);
  }
  mkdirSync(join(work, "code"));
  execFileSync("tar", ["-xzf", "code.tgz", "-C", "code"], { cwd: work });
  // All three switched on at once: the gateway names one the founder and the others join it.
  docker("up", "-d", ...BOARDS, ...BOARDS.map((id) => `${id}-link`));
  await until(allUp, "the three boards join and elect an orchestrator", 180);
});

after(() => {
  try {
    if (existsSync(composeFile)) docker("down", "-v", "--remove-orphans");
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
});

test("on the boards, a refresh fetches each source as the browser that asked, and that browser collects exactly what the sources served", { timeout: 180_000 }, async () => {
  const job = await refresh();
  const done = await until((current) => current.jobs.some((entry) => entry.id === job && entry.doneAt !== null), "the refresh is done");

  assert.deepEqual(outputs(done, job), {
    jira: "Loaded 3 Jira tickets",
    slack: "Loaded 2 Slack messages",
    github: "Loaded 1 GitHub issue",
    outlook: "Outlook not loaded: Outlook is not connected. Connect Outlook.",
    teams: "Loaded 1 Teams message",
  });
  // The work was split: more than one board fetched.
  assert.ok(new Set(done.tasks.filter((task) => task.job === job && task.source).map((task) => task.runs.at(-1)!.worker)).size > 1);
  assert.ok((await asked()).every((request) => request.sid === SID));

  const collect = (source: string, headers = asker) => post(`/api/cluster/refresh/${job}/${source}`, headers);
  assert.deepEqual(await (await collect("slack")).json(), { messages: [{ text: "Can you review my PR?" }, { text: "Demo is at 2" }] });
  assert.deepEqual(await (await collect("jira")).json(), { issues: [{ key: "QT1S-46" }, { key: "QT1S-10" }, { key: "QT1S-53" }] });
  assert.equal((await collect("outlook")).status, 404);
  assert.equal((await collect("slack", { origin: APP, cookie: `sid=${"cd".repeat(32)}` })).status, 404);
  assert.equal((await collect("slack", { origin: "http://elsewhere.test", cookie: `sid=${SID}` })).status, 403);

  // What every page reads holds counts only: no sid, no handle, no item text.
  const seen = JSON.stringify(await state());
  assert.ok(!seen.includes(SID) && !seen.includes("asker") && !seen.includes("Can you review my PR?"));
});

test("a board that loses power mid-fetch: another board fetches the source again, the browser still collects it, and the board rejoins", { timeout: 300_000 }, async () => {
  const before = (await asked()).filter((request) => request.path === "/api/slack/messages").length;
  const job = await refresh();
  // Slack takes 4 s to answer, so once its request has reached Slack the board is mid-fetch.
  let busy: State;
  for (;;) {
    busy = await until((current) => current.tasks.some((task) => task.job === job && task.source === "slack" && task.status === "claimed"), "a board claims the Slack fetch");
    if ((await asked()).filter((request) => request.path === "/api/slack/messages").length > before) break;
    await sleep(200);
  }
  const board = busy.tasks.find((task) => task.job === job && task.source === "slack")!.worker!;
  execFileSync("docker", ["kill", `${PROJECT}-${board}-1`], { stdio: "ignore" });

  const done = await until((current) => current.jobs.some((entry) => entry.id === job && entry.doneAt !== null), "the refresh is done without the dead board", 180);
  const step = done.tasks.find((task) => task.job === job && task.source === "slack")!;
  assert.deepEqual(step.lostBy, [board]);
  assert.notEqual(step.runs.at(-1)!.worker, board);
  assert.equal(step.output?.summary, "Loaded 2 Slack messages");
  // Today stops waiting for a refresh after 30 s (REFRESH_WAIT_MS) and loads the sources itself.
  const { queuedAt, doneAt } = done.jobs.find((entry) => entry.id === job)!;
  assert.ok(doneAt! - queuedAt < 30_000, `the refresh took ${doneAt! - queuedAt} ms`);
  assert.equal((await asked()).filter((request) => request.path === "/api/slack/messages").length, before + 2);
  assert.deepEqual(await (await post(`/api/cluster/refresh/${job}/slack`, asker)).json(), { messages: [{ text: "Can you review my PR?" }, { text: "Demo is at 2" }] });

  // Power back on: the board comes back from its saved log and rejoins.
  docker("up", "-d", board);
  docker("up", "-d", "--force-recreate", `${board}-link`);
  await until(allUp, `${board} rejoins`, 180);
});
