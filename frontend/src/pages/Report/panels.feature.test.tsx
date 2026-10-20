import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportPage } from "./Report";

const issue = {
  key: "QT1S-31",
  summary: "Worker hands back its task",
  status: "In Progress",
  issueType: "Task",
  updated: "2026-10-20T12:00:00Z",
  url: "https://example.atlassian.net/browse/QT1S-31",
  description: "Old description",
  sprints: [],
  labels: [],
  storyPointEstimate: 3,
  reporter: "Riley",
};

// What /api/jira/issues answers; a test can change it before the next sync.
let jiraIssues = () => Response.json({ issues: [issue] });

type Connection = { configured: boolean; connected: boolean; enabled: boolean };
const on: Connection = { configured: true, connected: true, enabled: true };
const off: Connection = { configured: true, connected: false, enabled: false };

function mockBackends(connections: Record<"jira" | "slack" | "github", Connection>, posts: Array<{ path: string; body: unknown }> = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/snapdragons/, "");
    if (init?.method === "POST") {
      posts.push({ path, body: JSON.parse(String(init.body)) });
      return Response.json({ ok: true });
    }
    const source = path.match(/^\/api\/(jira|slack|github)\/connection$/)?.[1] as keyof typeof connections | undefined;
    if (source) return Response.json({ [source]: connections[source] });
    if (path === "/api/jira/issues") return jiraIssues();
    if (path === "/api/jira/issues/QT1S-31/transitions") return Response.json({ transitions: [{ id: "41", name: "Done", status: "Done" }] });
    if (path === "/api/slack/messages") return Response.json({ messages: [] });
    if (path === "/api/github/issues") return Response.json({ issues: [] });
    return Response.json({ error: "Not found" }, { status: 404 });
  }));
}

function panel(title: string) {
  return screen.getByRole("region", { name: title });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  jiraIssues = () => Response.json({ issues: [issue] });
});

async function editDescription(text: string) {
  fireEvent.click(await screen.findByRole("button", { name: "Show details for QT1S-31" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit" }));
  fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
}

describe("Report panels", () => {
  it("says which source is not connected and counts it as a dash", async () => {
    mockBackends({ jira: off, slack: on, github: on });
    render(<ReportPage />);
    expect(await screen.findByText("Jira is not connected.")).toBeTruthy();
    expect(panel("Jira").querySelector(".count")?.textContent).toBe("–");
    expect(await screen.findByText("Nobody is waiting on you in Slack.")).toBeTruthy();
    expect(panel("Slack").querySelector(".count")?.textContent).toBe("0");
  });

  it("only writes to Jira after Edit, and only the fields that changed", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    mockBackends({ jira: on, slack: on, github: on }, posts);
    render(<ReportPage />);
    fireEvent.click(await screen.findByRole("button", { name: "Show details for QT1S-31" }));
    expect(screen.queryByRole("textbox")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Edit" }));
    const save = screen.getByRole("button", { name: "Save to Jira" });
    expect(save.hasAttribute("disabled")).toBe(true);

    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change to Jira" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]).toEqual({ path: "/api/jira/issues/QT1S-31", body: { description: "New description" } });
    expect(await screen.findByText("Saved to Jira.")).toBeTruthy();
  });

  it("doesn't write back a value a sync changed while editing", async () => {
    const posts: Array<{ path: string; body: unknown }> = [];
    mockBackends({ jira: on, slack: on, github: on }, posts);
    render(<ReportPage />);
    await editDescription("New description");

    jiraIssues = () => Response.json({ issues: [{ ...issue, storyPointEstimate: 5 }] });
    fireEvent.click(screen.getByRole("button", { name: "Sync all" }));
    await screen.findByRole("button", { name: "Sync all" });

    fireEvent.click(screen.getByRole("button", { name: "Save 1 change to Jira" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0].body).toEqual({ description: "New description" });
  });

});
