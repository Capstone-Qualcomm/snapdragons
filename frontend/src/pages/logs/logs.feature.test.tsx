import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LogsPage } from "./logs";

function event(id: number, timestamp: string, status = 200, count: number | null = 1) {
  return { id, timestamp, status, count };
}

type Events = ReturnType<typeof event>[];
type Activity = { jira?: Events; slack?: Events; github?: Events };

function mockActivity(activity: Activity, failedSource?: string) {
  vi.stubGlobal("fetch", vi.fn(async (url: string) => {
    const path = String(url);
    if (path.endsWith("/api/jira/logs")) return Response.json({ logs: [] });
    const source = path.match(/\/api\/(jira|slack|github)\/activity$/)?.[1] as keyof Activity;
    if (source === failedSource) return Response.json({}, { status: 503 });
    return Response.json({ events: activity[source] ?? [] });
  }));
}

function activityPanel() {
  return screen.getByText("Source sync activity").closest("details") as HTMLDetailsElement;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("Source sync activity", () => {
  it("combines three sources and puts the newest fetch first", async () => {
    mockActivity({
      jira: [event(1, "2026-10-15T10:00:00Z")],
      slack: [event(2, "2026-10-15T10:02:00Z")],
      github: [event(3, "2026-10-15T10:01:00Z")],
    });
    render(<LogsPage />);
    await screen.findByText("Slack");
    expect([...document.querySelectorAll(".sync-events li strong")].map((item) => item.textContent))
      .toEqual(["Slack", "GitHub", "Jira"]);
  });

  it("explains success, sign-in, disabled, and failed fetches", async () => {
    mockActivity({ jira: [
      event(1, "2026-10-15T10:04:00Z", 200, 4),
      event(2, "2026-10-15T10:03:00Z", 401, null),
      event(3, "2026-10-15T10:02:00Z", 403, null),
      event(4, "2026-10-15T10:01:00Z", 502, null),
    ] });
    render(<LogsPage />);
    expect(await screen.findByText("Loaded 4 items")).toBeTruthy();
    expect(screen.getByText("Sign-in required")).toBeTruthy();
    expect(screen.getByText("Source turned off")).toBeTruthy();
    expect(screen.getByText("Fetch failed (HTTP 502)")).toBeTruthy();
  });

  it("reports an unavailable source while keeping the other events", async () => {
    mockActivity({ jira: [event(1, "2026-10-15T10:00:00Z", 200, 2)] }, "slack");
    render(<LogsPage />);
    expect(await screen.findByText("Activity unavailable: Slack")).toBeTruthy();
    expect(screen.getByText("Loaded 2 items")).toBeTruthy();
  });

  it("collapses into the summary bar and opens again", async () => {
    mockActivity({ github: [event(1, "2026-10-15T10:00:00Z")] });
    render(<LogsPage />);
    await screen.findByText("GitHub");
    const panel = activityPanel();
    expect(panel.open).toBe(true);
    fireEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(false);
    fireEvent.click(panel.querySelector("summary")!);
    expect(panel.open).toBe(true);
  });

  it("keeps polling while collapsed so new activity appears on reopening", async () => {
    let jiraRequests = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith("/api/jira/logs")) return Response.json({ logs: [] });
      if (path.endsWith("/api/jira/activity")) {
        jiraRequests += 1;
        return Response.json({ events: jiraRequests === 1 ? [] : [event(1, "2026-10-15T10:00:00Z", 200, 3)] });
      }
      return Response.json({ events: [] });
    }));
    vi.useFakeTimers();
    render(<LogsPage />);
    await act(async () => {});
    const panel = activityPanel();
    fireEvent.click(panel.querySelector("summary")!);
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(jiraRequests).toBe(2);
    fireEvent.click(panel.querySelector("summary")!);
    expect(screen.getByText("Loaded 3 items")).toBeTruthy();
  });
});
