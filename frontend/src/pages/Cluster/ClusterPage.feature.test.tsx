import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClusterPage } from "./ClusterPage";

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

// Answers GET with the given state and records every POST.
function mockCluster(state: unknown, postReply: () => Response = () => Response.json({ ok: true })) {
  const fetch = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? postReply() : Response.json(state)));
  vi.stubGlobal("fetch", fetch);
  return () => fetch.mock.calls.filter(([, init]) => init?.method === "POST").map(([url, init]) => [url, JSON.parse(String(init?.body))]);
}

const row = (id: string) => screen.getByRole("group", { name: id });
const openBoard = (id: string) => fireEvent.click(row(id).querySelector(".board-face")!);
const showPanel = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("Cluster boards", () => {
  it("crowns the orchestrator's board, and shows a board's role, term and log once it is opened", async () => {
    mockCluster(cluster());
    render(<ClusterPage />);
    await screen.findByRole("group", { name: "Q-01" });

    expect(within(row("Q-02")).getByRole("img", { name: "Orchestrator" })).toBeTruthy();
    expect(screen.queryByText("term 3")).toBeNull();
    openBoard("Q-02");
    expect(within(row("Q-02")).getByText("Orchestrator")).toBeTruthy();
    openBoard("Q-01");
    expect(within(row("Q-02")).queryByText("Orchestrator")).toBeNull();
    expect(within(row("Q-01")).getByText("Worker")).toBeTruthy();
    expect(within(row("Q-01")).getByText("term 3")).toBeTruthy();
    expect(within(row("Q-01")).getByText("log 41")).toBeTruthy();
    expect(within(row("Q-01")).getByText("commit 40")).toBeTruthy();
  });

  it("while there is no orchestrator, shows each worker's election countdown and a candidate's votes", async () => {
    mockCluster(cluster({ orchestrator: null, nodes: [node("Q-01", { electionIn: 1200 }), node("Q-03", { role: "candidate", term: 4, votes: ["Q-03"] })] }));
    render(<ClusterPage />);

    await screen.findByRole("group", { name: "Q-01" });
    expect(screen.queryByRole("img", { name: "Orchestrator" })).toBeNull();
    expect(within(row("Q-01")).getByLabelText("election in 1.2 s")).toBeTruthy();
    openBoard("Q-03");
    expect(within(row("Q-03")).getByText("Candidate")).toBeTruthy();
    expect(within(row("Q-03")).getByLabelText("1 of 2 votes")).toBeTruthy();
  });

  it("shows a step picked up from a dead node continuing from its checkpoint", async () => {
    const resumed = task("T-5", "Fetch Slack messages", {
      status: "claimed",
      worker: "Q-03",
      lostBy: ["Q-01"],
      progress: 0.7,
      runs: [run("Q-01", { end: now - 6000, to: 0.4, outcome: "lost" }), run("Q-03", { start: now - 3000, from: 0.4, to: 0.7 })],
    });
    mockCluster(cluster({ tasks: [resumed], nodes: [node("Q-01", { up: false, role: undefined }), node("Q-02", { role: "orchestrator" }), node("Q-03")] }));
    render(<ClusterPage />);
    await screen.findByRole("group", { name: "Q-01" });

    expect(row("Q-01").className).toContain("is-dead");
    expect(within(row("Q-03")).getByText("from Q-01")).toBeTruthy();
    expect(document.querySelectorAll(".run.is-lost")).toHaveLength(1);
    expect(document.querySelectorAll(".handoff")).toHaveLength(1);
  });

  it("sends kill, remove and restart for the node they belong to", async () => {
    const posts = mockCluster(cluster({ nodes: [node("Q-01", { up: false }), node("Q-02", { role: "orchestrator" })] }));
    render(<ClusterPage />);
    await screen.findByRole("group", { name: "Q-01" });

    expect(within(row("Q-02")).queryByText("Kill")).toBeNull();
    openBoard("Q-02");
    fireEvent.click(within(row("Q-02")).getByText("Kill"));
    openBoard("Q-02");
    fireEvent.click(within(row("Q-02")).getByText("Remove"));
    openBoard("Q-01");
    fireEvent.click(within(row("Q-01")).getByText("Restart"));
    await act(async () => {});

    expect(posts().map(([url]) => url)).toEqual(["/api/cluster/nodes/Q-02/kill", "/api/cluster/nodes/Q-02/remove", "/api/cluster/nodes/Q-01/start"]);
  });
});

describe("Cluster controls", () => {
  it("runs a refresh, adds a node and turns auto refresh off", async () => {
    const posts = mockCluster(cluster());
    render(<ClusterPage />);
    await screen.findByRole("group", { name: "Q-01" });

    fireEvent.click(screen.getByText("Refresh"));
    fireEvent.click(screen.getByText("Add node"));
    fireEvent.click(screen.getByLabelText("Auto refresh"));
    await act(async () => {});

    expect(posts()).toEqual([["/api/cluster/refresh", {}], ["/api/cluster/nodes", {}], ["/api/cluster/auto", { on: false }]]);
  });

  it("shows why the cluster turned a request away", async () => {
    mockCluster(cluster(), () => Response.json({ error: "All 6 nodes are in use." }, { status: 409 }));
    render(<ClusterPage />);
    fireEvent.click(await screen.findByText("Add node"));

    expect((await screen.findByRole("alert")).textContent).toBe("All 6 nodes are in use.");
  });

  it("says when the cluster cannot be reached, and rejects malformed data", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ nodes: "nope" })));
    render(<ClusterPage />);

    expect((await screen.findByRole("alert")).textContent).toBe("The cluster is not reachable.");
    expect(screen.queryByRole("list", { name: "Nodes" })).toBeNull();
  });

  it("warns when the cluster stops answering, and keeps the last state it got", async () => {
    mockCluster(cluster());
    render(<ClusterPage />);
    await screen.findByRole("group", { name: "Q-01" });

    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));
    expect((await screen.findByRole("alert")).textContent).toBe("The cluster is not reachable. Showing the last received state.");
    expect(row("Q-01")).toBeTruthy();
  });
});

describe("Cluster refreshes", () => {
  it("shows the latest refresh step by step, with who did each step", async () => {
    const steps = [
      task("T-1", "Fetch Jira tickets", { status: "done", worker: "Q-01", progress: 1, runs: [run("Q-01", { end: now - 1000, to: 1, outcome: "done" })] }),
      task("T-2", "Fetch Slack messages", { status: "done", worker: "Q-03", lostBy: ["Q-02"], progress: 1, runs: [run("Q-02", { outcome: "lost", end: now - 3000 }), run("Q-03", { end: now - 500, to: 1, outcome: "done" })] }),
      task("T-3", "Rank today's list", { after: ["T-1", "T-2"] }),
    ];
    mockCluster(cluster({ tasks: steps, jobs: [{ id: "J-2", name: "Morning refresh", queuedAt: now - 5000, doneAt: null, nodes: null }] }));
    render(<ClusterPage />);
    await screen.findByRole("button", { name: "Steps" });
    showPanel("Steps");
    const refresh = await screen.findByRole("region", { name: "Latest refresh" });

    expect(within(refresh).getByText("J-2 Morning refresh")).toBeTruthy();
    const slack = within(refresh).getByText("Fetch Slack messages").closest("li") as HTMLElement;
    expect(slack.querySelector("s")?.textContent).toBe("Q-02");
    expect(within(slack).getByText("Q-03")).toBeTruthy();
  });

  it("averages refresh time by how many nodes ran each refresh, one column per node count", async () => {
    const job = (id: number, seconds: number, nodes: number) => ({ id: `J-${id}`, name: "Morning refresh", queuedAt: 0, doneAt: seconds * 1000, nodes });
    mockCluster(cluster({ jobs: [job(1, 20, 1), job(2, 10, 3), job(3, 8, 3), job(4, 6, 6)] }));
    render(<ClusterPage />);
    await screen.findByRole("button", { name: "Refresh time" });
    showPanel("Refresh time");
    const times = await screen.findByRole("region", { name: "Refresh time by node count" });

    const columns = [...times.querySelectorAll("li")].map((item) => item.textContent);
    expect(columns).toEqual(["20.0 s1 node×1", "2 nodes", "9.0 s3 nodes×2", "4 nodes", "5 nodes", "6.0 s6 nodes×1"]);
    expect(times.querySelector(".is-current")?.textContent).toContain("3 nodes");
  });

  it("shows the timeline first and one detail at a time", async () => {
    mockCluster(cluster());
    render(<ClusterPage />);
    expect(await screen.findByRole("region", { name: "Timeline" })).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Activity" })).toBeNull();
    showPanel("Activity");
    expect(screen.queryByRole("region", { name: "Timeline" })).toBeNull();
  });

  it("shows the refresh the nodes are working on, not one still waiting behind it", async () => {
    const job = (id: number, doneAt: number | null) => ({ id: `J-${id}`, name: "Morning refresh", queuedAt: 0, doneAt, nodes: null });
    mockCluster(cluster({ jobs: [job(1, 5000), job(2, null), job(3, null)] }));
    render(<ClusterPage />);
    await screen.findByRole("button", { name: "Steps" });
    showPanel("Steps");
    const refresh = await screen.findByRole("region", { name: "Latest refresh" });
    expect(within(refresh).getByText("J-2 Morning refresh")).toBeTruthy();
  });
});

describe("Cluster activity", () => {
  function mockActivity(sources: Record<string, unknown[]>, events: unknown[] = []) {
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const source = String(url).match(/\/api\/(jira|slack|github)\/activity$/)?.[1];
      if (source === "slack") return Response.json({}, { status: 503 });
      if (source) return Response.json({ events: sources[source] ?? [] });
      return Response.json(cluster({ now: Date.now(), events }));
    }));
  }

  it("merges what the cluster did with each source's syncs, newest first", async () => {
    const at = Date.now();
    mockActivity({
      jira: [{ id: 1, timestamp: new Date(at - 3000).toISOString(), status: 200, count: 4 }, { id: 2, timestamp: new Date(at - 5000).toISOString(), status: 401, count: null }],
      github: [{ id: 1, timestamp: new Date(at - 1000).toISOString(), status: 502, count: null }],
    }, [{ at: at - 2000, text: "Q-02 claimed T-4 (Fetch Slack messages)" }]);
    render(<ClusterPage />);
    await screen.findByRole("button", { name: "Activity" });
    showPanel("Activity");
    const activity = await screen.findByRole("region", { name: "Activity" });
    await within(activity).findByText("Loaded 4 items");

    expect([...activity.querySelectorAll("li")].map((item) => item.lastElementChild?.textContent)).toEqual([
      "Fetch failed (HTTP 502)",
      "Q-02 claimed T-4 (Fetch Slack messages)",
      "Loaded 4 items",
      "Sign-in required",
    ]);
  });
});
