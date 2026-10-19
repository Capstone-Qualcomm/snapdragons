import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsolePage } from "./Console";

const worker = {
  id: "Q-01",
  lastSeen: new Date().toISOString(),
  current: "job-2",
  done: 3,
};

function cluster(tasks: string[]) {
  return { workers: [worker], tasks: tasks.map((status) => ({ status })) };
}

function mockState(...states: unknown[]) {
  let call = 0;
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(states[Math.min(call++, states.length - 1)])));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function totals() {
  return [...document.querySelectorAll(".console-summary span")]
    .map((item) => item.textContent?.replace(/\s+/g, " ").trim())
    .join(" ");
}

describe("Console queue summary", () => {
  it("counts queued, claimed, and done tasks from cluster state", async () => {
    mockState(cluster(["queued", "queued", "claimed", "done"]));
    render(<ConsolePage />);
    await screen.findByText("Working on job-2");
    expect(totals()).toBe("queued 2 claimed 1 done 1");
  });

  it("updates totals on the existing one-second poll", async () => {
    mockState(cluster(["queued"]), cluster(["claimed"]));
    vi.useFakeTimers();
    render(<ConsolePage />);
    await act(async () => {});
    expect(totals()).toBe("queued 1 claimed 0 done 0");
    await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
    expect(totals()).toBe("queued 0 claimed 1 done 0");
  });

  it("shows unavailable after a failed request instead of zero jobs", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
    render(<ConsolePage />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Cluster unavailable");
    expect(screen.getAllByText("Waiting for node connection")).toHaveLength(6);
  });

  it("rejects malformed cluster data", async () => {
    mockState({ workers: [], tasks: [{ status: "mystery" }] });
    render(<ConsolePage />);
    expect(await screen.findByRole("status")).toHaveProperty("textContent", "Cluster unavailable");
  });
});

describe("Console failover", () => {
  it("shows a quiet node as lost and the node that took over its task", async () => {
    mockState({
      workers: [
        { id: "Q-01", lastSeen: new Date().toISOString(), current: "T-3", takenFrom: "Q-02", done: 1 },
        { id: "Q-02", lastSeen: new Date(Date.now() - 10_000).toISOString(), current: null, takenFrom: null, done: 0 },
      ],
      tasks: [{ status: "claimed" }],
    });
    render(<ConsolePage />);
    expect(await screen.findByText("Took over from Q-02")).toBeTruthy();
    expect(screen.getByText("No heartbeat")).toBeTruthy();
    expect(screen.getAllByText("Waiting for node connection")).toHaveLength(4);
  });
});

describe("Console simulation", () => {
  const now = () => new Date().toISOString();
  const job = { id: "J-1", name: "Morning refresh" };
  const step = (id: string, input: string, status: string, worker: string | null, lostBy: string[] = []) => ({ id, input, status, worker, lostBy, job });

  it("lists the nodes the cluster reports, up to its cap", async () => {
    mockState({ workers: [{ id: "Q-04", lastSeen: now(), current: null, done: 0 }], tasks: [], events: [], maxNodes: 3 });
    render(<ConsolePage />);
    expect(await screen.findByText("Q-04")).toBeTruthy();
    expect(screen.getByText("IDLE")).toBeTruthy();
    expect(screen.getAllByText("Waiting for node connection")).toHaveLength(2);
  });

  it("keeps showing which node lost a step after another one finishes it", async () => {
    mockState({
      workers: [{ id: "Q-01", lastSeen: now(), current: null, done: 1 }],
      tasks: [step("T-1", "Fetch Jira", "done", "Q-01", ["Q-02"]), step("T-2", "Rank", "queued", null)],
      events: [{ at: now(), text: "Q-01 took over T-1 (Fetch Jira) from Q-02" }],
      maxNodes: 6,
    });
    render(<ConsolePage />);
    expect(await screen.findByText("lost by Q-02")).toBeTruthy();
    expect(screen.getByText("done by Q-01")).toBeTruthy();
    expect(screen.getByText("1/2 done")).toBeTruthy();
    expect(screen.getByText("Q-01 took over T-1 (Fetch Jira) from Q-02")).toBeTruthy();
  });

  it("sends kill and restart for a node, and the morning refresh as a job", async () => {
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ ok: true })
      : Response.json({
          workers: [
            { id: "Q-01", lastSeen: now(), current: null, done: 0 },
            { id: "Q-02", lastSeen: new Date(Date.now() - 10_000).toISOString(), current: null, done: 0 },
          ],
          tasks: [],
          events: [],
          maxNodes: 6,
        }));
    vi.stubGlobal("fetch", fetch);
    render(<ConsolePage />);
    (await screen.findByText("Kill")).click();
    screen.getByText("Restart").click();
    screen.getByText("Run morning refresh").click();
    await act(async () => {});

    const posts = fetch.mock.calls.filter(([, init]) => init?.method === "POST");
    expect(posts.map(([url]) => url)).toEqual(["/api/cluster/nodes/Q-01/kill", "/api/cluster/nodes/Q-02/start", "/api/cluster/jobs"]);
    expect(JSON.parse(String(posts[2][1]?.body)).steps).toEqual(["Fetch Jira", "Fetch Slack", "Fetch GitHub", "Fetch Outlook"]);
  });

  it("shows why the server turned a request away, and no Add node at the cap", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => init?.method === "POST"
      ? Response.json({ error: "The queue is full (30 tasks). Wait for some to finish." }, { status: 429 })
      : Response.json({ workers: [{ id: "Q-01", lastSeen: now(), current: null, done: 0 }], tasks: [], events: [], maxNodes: 1 })));
    render(<ConsolePage />);
    (await screen.findByText("Run morning refresh")).click();
    expect((await screen.findByRole("alert")).textContent).toBe("The queue is full (30 tasks). Wait for some to finish.");
    expect(screen.getByText("Add node")).toHaveProperty("disabled", true);
  });
});
