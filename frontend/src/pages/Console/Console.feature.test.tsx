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
