import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportPage } from "./Report";

const sources = vi.hoisted(() => ({
  slackReload: vi.fn(),
  githubReload: vi.fn(),
  slackStatus: "ready",
}));

vi.mock("./useSlackSource", () => ({
  useSlackSource: () => ({ status: sources.slackStatus, reload: sources.slackReload }),
}));
vi.mock("./useGitHubSource", () => ({
  useGitHubSource: () => ({ status: "ready", reload: sources.githubReload }),
}));
vi.mock("./Pipeline", () => ({ Pipeline: () => null }));
vi.mock("./SlackPanel", () => ({ SlackPanel: () => null }));
vi.mock("./GitHubPanel", () => ({ GitHubPanel: () => null }));
vi.mock("./jira/jiraReport", async () => {
  const { useEffect } = await import("react");
  return {
    JiraReport: ({ refreshKey, onSourceChange }: {
      refreshKey: number;
      onSourceChange: (source: unknown) => void;
    }) => {
      useEffect(() => {
        onSourceChange({ name: "jira", status: "ready" });
      }, [onSourceChange]);
      return <output data-testid="jira-refresh-key">{refreshKey}</output>;
    },
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  sources.slackStatus = "ready";
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

async function openReport() {
  render(<ReportPage />);
  await act(async () => {}); // Jira reports that it is ready after mounting.
}

function expectAllRefreshed() {
  expect(screen.getByTestId("jira-refresh-key").textContent).toBe("1");
  expect(sources.slackReload).toHaveBeenCalledOnce();
  expect(sources.githubReload).toHaveBeenCalledOnce();
}

describe("Report refresh", () => {
  it("syncs all three sources with the button", async () => {
    await openReport();
    fireEvent.click(screen.getByRole("button", { name: /sync all/i }));
    expectAllRefreshed();
  });

  it("syncs all three sources with the r shortcut", async () => {
    await openReport();
    fireEvent.keyDown(window, { key: "r" });
    expectAllRefreshed();
  });

  it("ignores the r shortcut while typing", async () => {
    await openReport();
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "r" });
    expect(sources.slackReload).not.toHaveBeenCalled();
    expect(sources.githubReload).not.toHaveBeenCalled();
    input.remove();
  });

  it("refreshes after five visible minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    await openReport();
    await act(async () => { await vi.advanceTimersByTimeAsync(299_999); });
    expect(sources.slackReload).not.toHaveBeenCalled();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expectAllRefreshed();
  });

  it("does not refresh while hidden, then refreshes when visible", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    await openReport();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(sources.slackReload).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    expectAllRefreshed();
  });

  it("skips automatic refresh while a source is loading", async () => {
    sources.slackStatus = "loading";
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-15T12:00:00Z"));
    await openReport();
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(screen.getByRole("button", { name: /syncing/i }).hasAttribute("disabled")).toBe(true);
    expect(sources.slackReload).not.toHaveBeenCalled();
    expect(sources.githubReload).not.toHaveBeenCalled();
  });
});
