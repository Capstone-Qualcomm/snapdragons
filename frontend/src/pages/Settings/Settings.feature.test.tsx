import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./Settings";

const connections: Record<string, { configured: boolean; connected: boolean; enabled: boolean; connectedAt: string | null; user?: string }> = {
  jira: { configured: true, connected: false, enabled: false, connectedAt: null },
  slack: { configured: false, connected: false, enabled: false, connectedAt: null },
  github: { configured: true, connected: true, enabled: false, connectedAt: "2026-10-18T12:00:00Z", user: "octo" },
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

function mockBackends(posts: string[] = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const [, source, rest] = String(url).match(/\/api\/(jira|slack|github)\/connection(.*)$/) ?? [];
    if (init?.method === "POST") {
      posts.push(`${source}${rest} ${init.body}`);
      return Response.json({ [source]: { ...connections[source], enabled: true } });
    }
    return Response.json({ [source]: connections[source] });
  }));
}

function card(name: string) {
  return screen.getByRole("listitem", { name });
}

describe("Settings connections", () => {
  it("shows each source's state with the matching action", async () => {
    mockBackends();
    render(<SettingsPage />);
    await within(card("Jira")).findByText("Not connected");
    expect(within(card("Jira")).getByRole("link", { name: "Connect Jira" })).toBeTruthy();
    expect(within(card("Slack")).getByText("Not set up")).toBeTruthy();
    expect(within(card("Slack")).queryByRole("link", { name: "Connect Slack" })).toBeNull();
    expect(within(card("GitHub")).getByText("Turned off")).toBeTruthy();
    expect(within(card("GitHub")).getByText("octo")).toBeTruthy();
  });

  it("turns a connected source on from its toggle", async () => {
    const posts: string[] = [];
    mockBackends(posts);
    render(<SettingsPage />);
    const toggle = await within(card("GitHub")).findByRole("checkbox", { name: "Show in Report" });
    await waitFor(() => expect(toggle.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await within(card("GitHub")).findByText("Connected");
    expect(posts).toEqual(['github/enabled {"enabled":true}']);
  });

  it("shows the outcome of a sign-in and clears it from the address", async () => {
    window.history.replaceState({}, "", "/snapdragons/settings?jira=invalid_state");
    mockBackends();
    render(<SettingsPage />);
    expect(await screen.findByText("The Jira sign-in expired or could not be verified. Connect again.")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("offers Retry when the first check fails", async () => {
    mockBackends();
    const working = vi.mocked(fetch).getMockImplementation()!;
    let jiraDown = true;
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (jiraDown && String(url).includes("/api/jira/")) throw new TypeError("Failed to fetch");
      return working(url, init);
    });
    render(<SettingsPage />);
    await within(card("Jira")).findByText("Not checked");
    jiraDown = false;
    fireEvent.click(within(card("Jira")).getByRole("button", { name: "Retry" }));
    expect(await within(card("Jira")).findByText("Not connected")).toBeTruthy();
    expect(within(card("Jira")).queryByRole("alert")).toBeNull();
  });
});
