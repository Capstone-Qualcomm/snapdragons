import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { titles } from "../Today/sources";

// A source request for any source the app knows, so one added to the app is mocked here too.
const sourceRoute = (url: string) => {
  const match = String(url).match(/\/api\/(\w+)\/(connection|activity)$/);
  return match && match[1] in titles ? { name: match[1], route: match[2] } : null;
};
const notSetUp = (name: string) => Response.json({ [name]: { configured: false, connected: false, enabled: false } });

const now = 1_000_000;
const node = (id: string, fields: Record<string, unknown> = {}) => ({ id, up: true, member: true, role: "worker", term: 3, votes: [], members: ["Q-01", "Q-02", "Q-03"], commitIndex: 40, lastIndex: 41, electionIn: 1800, quietFor: 100, ...fields });
const run = (worker: string, fields: Record<string, unknown> = {}) => ({ worker, start: now - 4000, heardAt: now - 1000, end: null, from: 0, to: 0.5, outcome: "running", ...fields });
const task = (id: string, input: string, fields: Record<string, unknown> = {}) => ({ id, input, status: "queued", worker: null, lostBy: [], job: "J-2", after: [], progress: 0, runs: [], ...fields });

function cluster(fields: Record<string, unknown> = {}) {
  return {
    tasks: [],
    jobs: [],
    workers: [],
    terms: [],
    events: [],
    now,
    auto: true,
    maxNodes: 6,
    orchestrator: "Q-02",
    term: 3,
    members: ["Q-01", "Q-02", "Q-03"],
    nodes: [node("Q-01"), node("Q-02", { role: "orchestrator" }), node("Q-03")],
    ...fields,
  };
}

// Answers the cluster's GET with the given state, every source as not set up,
// and records every POST to the cluster except the refresh the page starts on its own.
function mockCluster(state: unknown, postReply: () => Response = () => Response.json({ ok: true })) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    const source = sourceRoute(url);
    if (source?.route === "connection") return notSetUp(source.name);
    if (source) return Response.json({ events: [] });
    if (init?.method === "POST") return postReply();
    // Anything else is a 404, so a request the mock does not know fails loudly instead of getting the cluster state.
    return String(url).endsWith("/api/cluster/state") ? Response.json(state) : Response.json({ error: "Not found" }, { status: 404 });
  });
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);
}

function renderCluster() {
  window.history.replaceState({}, "", "/cluster");
  render(<App />);
}

const row = (name: string) => screen.getByRole("row", { name });
const boardsLoaded = () => screen.findByRole("row", { name: "Board 1" });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Cluster boards", () => {
  it("says which board is the orchestrator and which are workers, and shows a board's Raft numbers once it is opened", async () => {
    mockCluster(cluster());
    renderCluster();
    await boardsLoaded();

    expect(within(row("Board 2")).getByText("Orchestrator")).toBeTruthy();
    expect(within(row("Board 1")).getByText("Worker")).toBeTruthy();
    expect(within(row("Board 1")).getByText("Online")).toBeTruthy();
    expect(screen.queryByText("term 3")).toBeNull();
    fireEvent.click(within(row("Board 1")).getByRole("button", { name: "Board 1" }));
    expect(screen.getByText("term 3")).toBeTruthy();
    expect(screen.getByText("log 41")).toBeTruthy();
    expect(screen.getByText("commit 40")).toBeTruthy();
  });

  it("while there is no orchestrator, shows each worker's election countdown and a candidate's votes", async () => {
    mockCluster(cluster({ orchestrator: null, nodes: [node("Q-01", { electionIn: 1200 }), node("Q-03", { role: "candidate", term: 4, votes: ["Q-03"] })] }));
    renderCluster();
    await boardsLoaded();

    expect(screen.queryByText("Orchestrator", { selector: "td" })).toBeNull();
    expect(within(row("Board 1")).getByText("Worker, election in 1.2 s")).toBeTruthy();
    expect(within(row("Board 3")).getByText("Candidate, 1 of 2 votes")).toBeTruthy();
  });

  it("shows a step picked up from a dead board continuing from its checkpoint", async () => {
    const resumed = task("T-5", "Fetch Slack messages", {
      status: "claimed",
      worker: "Q-03",
      lostBy: ["Q-01"],
      progress: 0.7,
      runs: [run("Q-01", { end: now - 6000, to: 0.4, outcome: "lost" }), run("Q-03", { start: now - 3000, from: 0.4, to: 0.7 })],
    });
    mockCluster(cluster({ tasks: [resumed], nodes: [node("Q-01", { up: false, role: undefined }), node("Q-02", { role: "orchestrator" }), node("Q-03")] }));
    renderCluster();
    await boardsLoaded();

    expect(within(row("Board 1")).getByText("Down")).toBeTruthy();
    expect(within(row("Board 3")).getByText("Fetching Slack")).toBeTruthy();
    expect(within(row("Board 3")).getByText("Taken over from Board 1")).toBeTruthy();
    expect(document.querySelectorAll(".run.is-lost")).toHaveLength(1);
    expect(document.querySelectorAll(".handoff")).toHaveLength(1);
  });

  it("sends kill, remove and restart for the board they belong to, from its row", async () => {
    const posts = mockCluster(cluster({ nodes: [node("Q-01", { up: false }), node("Q-02", { role: "orchestrator" })] }));
    renderCluster();
    await boardsLoaded();

    expect(within(row("Board 1")).queryByText("Kill")).toBeNull();
    fireEvent.click(within(row("Board 2")).getByText("Kill"));
    fireEvent.click(within(row("Board 2")).getByText("Remove"));
    fireEvent.click(within(row("Board 1")).getByText("Restart"));
    await act(async () => {});

    expect(posts().map(([url]) => url).filter((url) => url !== "/api/cluster/refresh")).toEqual(["/api/cluster/nodes/Q-02/kill", "/api/cluster/nodes/Q-02/remove", "/api/cluster/nodes/Q-01/start"]);
  });
});

describe("Cluster controls", () => {
  it("runs a refresh, adds a board and turns auto refresh off", async () => {
    const posts = mockCluster(cluster());
    renderCluster();
    await boardsLoaded();
    fireEvent.click(screen.getByRole("button", { name: "Run refresh" }));
    fireEvent.click(screen.getByText("Add board"));
    fireEvent.click(screen.getByLabelText("Auto refresh"));
    await act(async () => {});

    expect(posts()).toEqual([["/api/cluster/refresh", {}], ["/api/cluster/nodes", {}], ["/api/cluster/auto", { on: false }]]);
  });

  it("shows why the cluster turned a request away", async () => {
    mockCluster(cluster(), () => Response.json({ error: "All 6 nodes are in use." }, { status: 409 }));
    renderCluster();
    // Add board stays disabled until the first state arrives.
    await boardsLoaded();
    fireEvent.click(screen.getByText("Add board"));

    expect((await screen.findByRole("alert")).textContent).toBe("All 6 nodes are in use.");
  });

  it("says when the cluster cannot be reached, and rejects malformed data", async () => {
    mockCluster({ nodes: "nope" });
    renderCluster();

    expect((await screen.findByRole("alert")).textContent).toBe("The cluster is not reachable.");
    expect(screen.queryByRole("table", { name: "Boards" })).toBeNull();
  });

  it("warns when the cluster stops answering, and keeps the last state it got", async () => {
    mockCluster(cluster());
    renderCluster();
    await boardsLoaded();

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await screen.findByRole("alert")).textContent).toBe("The cluster is not reachable. Showing the last received state.");
    expect(row("Board 1")).toBeTruthy();
  });

  it("says why no orchestrator can be elected while too few boards are up", async () => {
    mockCluster(cluster({ orchestrator: null, nodes: [node("Q-01"), node("Q-02", { up: false }), node("Q-03", { up: false })] }));
    renderCluster();
    expect((await screen.findByText(/No orchestrator:/)).textContent).toBe("No orchestrator: 1 of 3 boards are up, and an election needs 2. Restart a board to carry on.");
  });
});

describe("Cluster summary and charts", () => {
  it("counts boards online and names the orchestrator in the stat cards", async () => {
    mockCluster(cluster({ nodes: [node("Q-01", { up: false }), node("Q-02", { role: "orchestrator" }), node("Q-03")] }));
    renderCluster();
    await boardsLoaded();
    const stats = screen.getByRole("list", { name: "Summary" });

    expect(within(stats).getByText("2 / 3")).toBeTruthy();
    expect(within(stats).getByText("1 down")).toBeTruthy();
    expect(within(stats).getByText("Board 2")).toBeTruthy();
  });

  it("charts each finished refresh in seconds, and labels the newest", async () => {
    const job = (id: number, seconds: number, nodes: number) => ({ id: `J-${id}`, name: "Morning refresh", queuedAt: 0, doneAt: seconds * 1000, nodes });
    mockCluster(cluster({ jobs: [job(1, 20, 1), job(2, 10, 3), job(3, 8, 3), { id: "J-4", name: "Morning refresh", queuedAt: 0, doneAt: null, nodes: null }] }));
    renderCluster();
    const chart = await screen.findByRole("figure", { name: "Seconds per refresh, last 3" });

    expect(chart.querySelectorAll(".plot li")).toHaveLength(3);
    expect(chart.querySelector(".is-latest")?.textContent).toContain("8.0 s");
    expect(screen.getByText("12.7 s")).toBeTruthy();
  });

  it("shows the timeline with board names on its lanes", async () => {
    mockCluster(cluster());
    renderCluster();
    const timeline = await screen.findByRole("region", { name: "Timeline" });
    expect(timeline.querySelector(".lane-names")?.textContent).toBe("Board 1Board 2Board 3");
  });
});

describe("Cluster activity", () => {
  function mockActivity(sources: Record<string, unknown[]>, events: unknown[] = []) {
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const source = sourceRoute(url);
      if (source?.route === "connection") return notSetUp(source.name);
      if (source?.name === "slack") return Response.json({}, { status: 503 });
      if (source) return Response.json({ events: sources[source.name] ?? [] });
      if (init?.method === "POST") return Response.json({ ok: true });
      if (!String(url).endsWith("/api/cluster/state")) return Response.json({ error: "Not found" }, { status: 404 });
      return Response.json(cluster({ now: Date.now(), events, tasks: [task("T-4", "Fetch Slack messages")] }));
    }));
  }

  it("merges what the cluster did with each source's syncs, newest first, in plain sentences", async () => {
    const at = Date.now();
    mockActivity({
      jira: [{ id: 1, timestamp: new Date(at - 3000).toISOString(), status: 200, count: 4 }, { id: 2, timestamp: new Date(at - 5000).toISOString(), status: 401, count: null }],
      github: [{ id: 1, timestamp: new Date(at - 1000).toISOString(), status: 502, count: null }],
    }, [{ at: at - 2000, text: "Q-02 resumed T-4 (Fetch Slack messages) at 40%, lost by Q-01" }]);
    renderCluster();
    const activity = await screen.findByRole("list", { name: "Activity" });
    await within(activity).findByText("Jira: Loaded 4 items");

    expect([...activity.querySelectorAll("li")].map((item) => item.lastElementChild?.textContent)).toEqual([
      "GitHub: Fetch failed (HTTP 502)",
      "Orchestrator gave Board 1's “Fetch Slack messages” to Board 2 at 40%",
      "Jira: Loaded 4 items",
      "Jira: Sign-in required",
    ]);
    expect(screen.getByText("Slack activity could not be loaded. Showing what came in before.")).toBeTruthy();
  });
});
