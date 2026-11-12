import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import App from "../../App";
import { titles } from "./sources";
import type { SourceName } from "./sources";

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const issue = {
  key: "QT1S-31",
  summary: "Worker hands back its task",
  status: "In Progress",
  issueType: "Task",
  updated: minutesAgo(30),
  url: "https://example.atlassian.net/browse/QT1S-31",
  description: "Old description",
  sprints: ["Sprint 4"],
  labels: [],
  storyPointEstimate: 3,
  reporter: "Riley",
};
const dm = { id: "s1", kind: "dm", from: "Maya Chen", where: "Direct message", text: "Can you look at the demo?", sentAt: minutesAgo(10), url: "https://slack.test/dm" };
const mention = { id: "s2", kind: "mention", from: "Priya Raman", where: "#dev", text: "@you the deploy failed", sentAt: minutesAgo(1), url: "https://slack.test/m" };
const email = { id: "o1", from: "Jordan Lee", subject: "Demo slot moved to Thursday", receivedAt: minutesAgo(5), url: "https://outlook.test/o1" };
const pr = { id: "g1", kind: "pull_request", repository: "team/snapdragons", number: 15, title: "Snapshot the queue", state: "open", updatedAt: minutesAgo(60), url: "https://github.test/15" };

type Connection = { configured: boolean; connected: boolean; enabled: boolean };
const on: Connection = { configured: true, connected: true, enabled: true };
const off: Connection = { configured: false, connected: false, enabled: false };
// Every source the app knows, so one added to the app is mocked here too instead of failing as a 404.
const sourceNames = Object.keys(titles) as SourceName[];
const everySource = (connection: Connection) => Object.fromEntries(sourceNames.map((name) => [name, connection])) as Record<SourceName, Connection>;

const now = 1_000_000;
const node = (id: string, fields: Record<string, unknown> = {}) => ({ id, up: true, member: true, role: "worker", term: 2, votes: [], members: ["Q-01", "Q-02"], commitIndex: 9, lastIndex: 9, ...fields });
let clusterState: Record<string, unknown>;
let connections: Record<SourceName, Connection>;
let lists: Record<string, unknown>;
let jiraIssues: () => Response | Promise<Response>;
let githubComment: (() => Promise<Response>) | undefined;
let posts: Array<{ path: string; body: unknown }>;
// What the boards loaded in a refresh, by source; a source missing here falls back to the page's own list.
let boardLists: Record<string, unknown>;
let collects: string[];
// Whether the cluster finishes a refresh as soon as it is asked for one.
let finishRefreshes: boolean;
// Each refresh is a new job, J-7 first, as the cluster numbers them.
let nextJob: number;
let rankingCalls: Array<{ path: string; body: { items: Array<{ id: string }> } }>;

function idleCluster(fields: Record<string, unknown> = {}) {
  return { tasks: [], jobs: [], workers: [], terms: [], events: [], now, auto: false, maxNodes: 6, orchestrator: "Q-01", term: 2, members: ["Q-01", "Q-02"], nodes: [node("Q-01", { role: "orchestrator" }), node("Q-02")], ...fields };
}

beforeEach(() => {
  localStorage.clear();
  Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  clusterState = idleCluster();
  connections = everySource(on);
  lists = { slack: { messages: [mention, dm] }, github: { issues: [pr] }, outlook: { messages: [] }, teams: { messages: [] } };
  jiraIssues = () => Response.json({ issues: [issue] });
  githubComment = undefined;
  posts = [];
  boardLists = {};
  collects = [];
  finishRefreshes = true;
  nextJob = 7;
  rankingCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url).replace(/^\/snapdragons/, "");
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (path === "/api/today/rank") {
        rankingCalls.push({ path, body });
        return Response.json({ order: body.items.map((item: { id: string }) => item.id) });
      }
      const collect = path.match(/^\/api\/cluster\/refresh\/J-\d+\/(\w+)$/)?.[1];
      if (collect) {
        collects.push(collect);
        return collect in boardLists ? Response.json(boardLists[collect]) : Response.json({ error: "This refresh has no list from that source for this browser." }, { status: 404 });
      }
      posts.push({ path, body });
      if (path === "/api/cluster/refresh") {
        const id = `J-${nextJob++}`;
        clusterState = idleCluster({ jobs: [{ id, name: "Morning refresh", queuedAt: now, doneAt: finishRefreshes ? now + 1 : null, nodes: finishRefreshes ? 2 : null }] });
        return Response.json({ job: { id } }, { status: 201 });
      }
      if (path.endsWith("/comments") && githubComment) return githubComment();
      return Response.json({ ok: true });
    }
    if (path === "/api/cluster/state") return Response.json(clusterState);
    const source = path.match(/^\/api\/(\w+)\/connection$/)?.[1] as SourceName | undefined;
    if (source && sourceNames.includes(source)) return Response.json({ [source]: connections[source] });
    if (path === "/api/jira/issues") return jiraIssues();
    if (path === "/api/jira/issues/QT1S-31/transitions") return Response.json({ transitions: [{ id: "41", name: "Done", status: "Done" }] });
    if (path === "/api/slack/messages") return Response.json(lists.slack);
    if (path === "/api/github/issues") return Response.json(lists.github);
    if (path === "/api/outlook/messages") return Response.json(lists.outlook);
    if (path === "/api/teams/messages") return Response.json(lists.teams);
    return Response.json({ error: "Not found" }, { status: 404 });
  }));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  window.history.replaceState({}, "", "/");
});

// Goes to the Connections page the way a person would, from the top bar.
const openConnections = () => fireEvent.click(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Connections" }));
const rows = () => [...screen.getByRole("table", { name: "Today" }).querySelectorAll("tbody .task-row:not([hidden])")] as HTMLElement[];
const row = (text: string) => screen.getByRole("row", { name: text });
const sourceGets = (source: string) => vi.mocked(fetch).mock.calls.filter(([url, init]) => !init?.method && String(url).endsWith(`/api/${source}/connection`)).length;
// The page asking a source for its list itself, not through the cluster.
const listGets = (path: string) => vi.mocked(fetch).mock.calls.filter(([url, init]) => !init?.method && String(url).endsWith(path)).length;

// Today is one page of the app; a test that set its own address keeps it.
function renderToday() {
  if (!/today/.test(window.location.pathname)) window.history.replaceState({}, "", "/today");
  render(<App />);
}

async function openToday() {
  renderToday();
  await screen.findByRole("row", { name: "Worker hands back its task" });
}

describe("Today list", () => {
  it("ranks every source into one list: the DM and the pull request, then started Jira work, then the mention", async () => {
    await openToday();
    expect(rows().map((item) => item.getAttribute("aria-label"))).toEqual(["Can you look at the demo?", "Snapshot the queue", "Worker hands back its task", "@you the deploy failed"]);
    expect(within(row("Can you look at the demo?")).getByRole("button", { name: "Reply" })).toBeTruthy();
    expect(within(row("Can you look at the demo?")).getByRole("link", { name: "Open in app" }).getAttribute("href")).toBe("https://slack.test/dm");
    expect(within(row("Snapshot the queue")).getByRole("link", { name: "Open in app" }).getAttribute("href")).toBe("https://github.test/15");
    expect(within(row("Snapshot the queue")).getByRole("button", { name: "Comment" })).toBeTruthy();
    expect(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" })).toBeTruthy();
  });

  it("ranks unread email with the direct requests, answered from the row with Reply and Delete", async () => {
    lists.outlook = { messages: [email] };
    await openToday();
    expect(rows().map((item) => item.getAttribute("aria-label"))).toEqual(["Demo slot moved to Thursday", "Can you look at the demo?", "Snapshot the queue", "Worker hands back its task", "@you the deploy failed"]);
    expect(within(row("Demo slot moved to Thursday")).getByRole("button", { name: "Reply" })).toBeTruthy();
    expect(within(row("Demo slot moved to Thursday")).getByRole("button", { name: "Delete email" })).toBeTruthy();
  });

  it("clears an item with Done, keeps it cleared after a reload, and brings it back with Undo", async () => {
    await openToday();
    fireEvent.click(within(row("Can you look at the demo?")).getByRole("button", { name: "Done" }));
    expect(rows()).toHaveLength(3);
    expect(screen.getByText(/Done today/).closest("details")?.textContent).toContain("Can you look at the demo?");

    cleanup();
    await openToday();
    expect(rows()).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(rows()).toHaveLength(4);
  });

  it("brings a done item back once it changes", async () => {
    await openToday();
    fireEvent.click(within(row("Can you look at the demo?")).getByRole("button", { name: "Done" }));
    lists.slack = { messages: [mention, { ...dm, sentAt: minutesAgo(0) }] };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(rows()).toHaveLength(4));
  });

  it("keeps the GitHub comment draft and editor locked while a post is pending", async () => {
    let finishPost!: (response: Response) => void;
    githubComment = () => new Promise((resolve) => { finishPost = resolve; });
    await openToday();

    const githubRow = within(row("Snapshot the queue"));
    fireEvent.click(githubRow.getByRole("button", { name: "Comment" }));
    const textarea = screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: "Please check this change." } });
    fireEvent.click(screen.getByRole("button", { name: "Post comment to GitHub" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Posting…" }).hasAttribute("disabled")).toBe(true));
    expect(textarea.disabled).toBe(true);
    expect(githubRow.getByRole("button", { name: "Comment" }).hasAttribute("disabled")).toBe(true);
    expect(githubRow.getByRole("button", { name: "Done" }).hasAttribute("disabled")).toBe(true);

    await act(async () => finishPost(Response.json({ ok: true })));
    expect(await screen.findByText("Comment posted to GitHub.")).toBeTruthy();
    expect((screen.getByRole("textbox", { name: "Comment" }) as HTMLTextAreaElement).value).toBe("");
    expect(githubRow.getByRole("button", { name: "Comment" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("Today connections", () => {
  it("offers Connect for a source that is not connected, and leaves its items out", async () => {
    connections.slack = { configured: true, connected: false, enabled: false };
    connections.github = { configured: false, connected: false, enabled: false };
    await openToday();
    expect(rows()).toHaveLength(1);
    openConnections();
    expect(screen.getByRole("link", { name: "Connect Slack" }).getAttribute("href")).toBe("/auth/slack/start");
    expect(screen.getByRole("button", { name: "Connect GitHub" }).hasAttribute("disabled")).toBe(true);
  });

  it("turns a turned-off source back on", async () => {
    connections.github = { configured: true, connected: true, enabled: false };
    await openToday();
    openConnections();
    fireEvent.click(screen.getByRole("button", { name: "Turn on GitHub" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/github/connection/enabled", body: { enabled: true } }));
  });

  it("disconnects only after a second, confirming click, and keeps the buttons off until it is answered", async () => {
    await openToday();
    openConnections();
    fireEvent.click(screen.getByRole("button", { name: "Disconnect Jira" }));
    expect(posts.map((post) => post.path)).not.toContain("/api/jira/connection/disconnect");
    fireEvent.click(screen.getByRole("button", { name: "Confirm disconnect Jira" }));
    expect(screen.getByRole("button", { name: "Turn off Jira" }).hasAttribute("disabled")).toBe(true);
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/jira/connection/disconnect", body: {} }));
  });

  it("shows a failed sign-in from the address and clears it", async () => {
    window.history.replaceState({}, "", "/snapdragons/today?jira=invalid_state");
    await openToday();
    expect(screen.getByText("The Jira sign-in expired or could not be verified. Connect again.")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("shows sample rows, marked as such and never counted, and the connect buttons when no source is connected", async () => {
    connections = {
      jira: { configured: true, connected: false, enabled: false },
      slack: { configured: true, connected: false, enabled: false },
      github: off,
      outlook: off,
      teams: off,
    };
    renderToday();
    const sample = await screen.findByRole("table", { name: "Sample tasks" });
    expect(screen.getByText("Sample data")).toBeTruthy();
    expect(sample.querySelectorAll("tbody .task-row")).toHaveLength(4);
    expect(within(screen.getByRole("list", { name: "Summary" })).getAllByText("No source connected yet")).toHaveLength(2);
    // The note under the sample links to the Connections page, where each source has its button.
    fireEvent.click(screen.getByRole("link", { name: "Connect Slack, Jira, GitHub, Outlook or Teams" }));
    expect(screen.getByRole("heading", { name: "Connections", level: 1 })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Connect Slack" }).getAttribute("href")).toBe("/auth/slack/start");
    expect(screen.getByRole("button", { name: "Connect GitHub" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Connect Outlook" }).hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Connect Teams" }).hasAttribute("disabled")).toBe(true);
  });

  it("shows an all-clear, not sample data, when a connected source has nothing", async () => {
    lists = { slack: { messages: [] }, github: { issues: [] }, outlook: { messages: [] }, teams: { messages: [] } };
    jiraIssues = () => Response.json({ issues: [] });
    renderToday();
    expect(await screen.findByText("Nothing waiting. You are all caught up.")).toBeTruthy();
    expect(screen.queryByText("Sample data")).toBeNull();
  });

  it("gives the all-clear only once every connected source has loaded", async () => {
    lists = { slack: { messages: [] }, github: { issues: [] }, outlook: { messages: [] }, teams: { messages: [] } };
    jiraIssues = () => Response.json({ error: "Jira is down." }, { status: 502 });
    renderToday();
    expect(await screen.findByText("Nothing to show, but a source could not be loaded.")).toBeTruthy();
    expect(screen.queryByText("Nothing waiting. You are all caught up.")).toBeNull();
  });

  it("does not show sample data for a connected source that is still loading or failed", async () => {
    connections.slack = { configured: true, connected: false, enabled: false };
    connections.github = { configured: false, connected: false, enabled: false };
    let fail = () => {};
    jiraIssues = () => new Promise((resolve) => (fail = () => resolve(Response.json({ error: "Jira is down." }, { status: 502 }))));
    renderToday();
    await waitFor(() => expect(sourceGets("jira")).toBe(1));
    await act(async () => {});
    expect(screen.queryByText("Sample data")).toBeNull();
    await act(async () => fail());
    expect(await screen.findByText("Jira: Jira is down.")).toBeTruthy();
    expect(screen.queryByText("Sample data")).toBeNull();
  });

  it("says the sources are loading, not that none is connected, before they answer", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})));
    renderToday();
    const stats = within(screen.getByRole("list", { name: "Summary" }));
    expect(stats.queryByText("No source connected yet")).toBeNull();
    expect(stats.queryByText("0 / 4")).toBeNull();
    expect(stats.getAllByText("Loading your sources…")).toHaveLength(3);
  });
});

describe("Today refresh", () => {
  it("gives the cluster a refresh job when it opens, or follows the one already running", async () => {
    await openToday();
    await waitFor(() => expect(posts.map((post) => post.path)).toEqual(["/api/cluster/refresh"]));

    cleanup();
    posts = [];
    clusterState = idleCluster({ jobs: [{ id: "J-3", name: "Morning refresh", queuedAt: now, doneAt: null, nodes: null }] });
    await openToday();
    await act(async () => {});
    expect(posts).toEqual([]);
  });

  it("runs a cluster job and syncs every source from the button and the r shortcut", async () => {
    await openToday();
    await waitFor(() => expect(posts).toHaveLength(1));
    // The job counts as running until the cluster finishes it.
    clusterState = idleCluster({ jobs: [{ id: "J-7", name: "Morning refresh", queuedAt: now, doneAt: now + 1, nodes: 2 }] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));

    const before = sourceGets("slack");
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() => expect(sourceGets("slack")).toBe(before + 1));
    expect(sourceGets("jira")).toBe(before + 1);
    expect(sourceGets("github")).toBe(before + 1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));

    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(posts).toHaveLength(3));
  });

  it("shows what the boards loaded, and does not ask the sources for their lists again", async () => {
    await openToday();
    await waitFor(() => expect(collects).toHaveLength(5));
    const slackGets = listGets("/api/slack/messages");
    const jiraGets = listGets("/api/jira/issues");
    collects = [];
    boardLists = { slack: { messages: [mention, dm, { ...dm, id: "s3", text: "Loaded on a board" }] }, jira: { issues: [issue] }, github: { issues: [pr] }, outlook: { messages: [] }, teams: { messages: [] } };

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("row", { name: "Loaded on a board" })).toBeTruthy();
    await waitFor(() => expect([...collects].sort()).toEqual(["github", "jira", "outlook", "slack", "teams"]));
    expect(listGets("/api/slack/messages")).toBe(slackGets);
    expect(listGets("/api/jira/issues")).toBe(jiraGets);
  });

  it("loads a source itself when the boards have no list from it", async () => {
    await openToday();
    await waitFor(() => expect(collects).toHaveLength(5));
    const githubGets = listGets("/api/github/issues");
    const slackGets = listGets("/api/slack/messages");
    boardLists = { slack: { messages: [mention, dm] }, jira: { issues: [issue] }, outlook: { messages: [] }, teams: { messages: [] } };
    lists.github = { issues: [{ ...pr, id: "g2", number: 16, title: "Loaded by the page" }] };

    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByRole("row", { name: "Loaded by the page" })).toBeTruthy();
    expect(listGets("/api/github/issues")).toBe(githubGets + 1);
    expect(listGets("/api/slack/messages")).toBe(slackGets);
  });

  it("loads every source itself when the cluster goes away mid-refresh", async () => {
    finishRefreshes = false;
    await openToday();
    await screen.findByRole("button", { name: "Refreshing" });
    const slackGets = listGets("/api/slack/messages");
    lists.slack = { messages: [mention, dm, { ...dm, id: "s3", text: "Loaded once the cluster was gone" }] };

    clusterState = { error: "down" };
    expect(await screen.findByRole("row", { name: "Loaded once the cluster was gone" })).toBeTruthy();
    expect(listGets("/api/slack/messages")).toBe(slackGets + 1);
    expect(collects).toEqual([]);
  });

  it("loads every source itself when a refresh is not done in 30 s, and can refresh again", async () => {
    // An orchestrator left with too few boards still answers, but never finishes the job.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    finishRefreshes = false;
    await openToday();
    await screen.findByRole("button", { name: "Refreshing" });
    const slackGets = listGets("/api/slack/messages");
    lists.slack = { messages: [mention, dm, { ...dm, id: "s3", text: "Loaded after the wait" }] };

    await act(async () => { await vi.advanceTimersByTimeAsync(29_000); });
    expect(listGets("/api/slack/messages")).toBe(slackGets);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(await screen.findByRole("row", { name: "Loaded after the wait" })).toBeTruthy();
    expect(collects).toEqual([]);
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("keeps a Jira save made during a refresh, instead of the older list the boards loaded", async () => {
    finishRefreshes = false;
    await openToday();
    await screen.findByRole("button", { name: "Refreshing" });
    fireEvent.click(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New description" } });
    jiraIssues = () => Response.json({ issues: [{ ...issue, summary: "Saved during the refresh" }] });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change to Jira" }));
    expect(await screen.findByRole("row", { name: "Saved during the refresh" })).toBeTruthy();

    // The boards loaded Jira before the save.
    boardLists = { slack: { messages: [mention, dm] }, jira: { issues: [issue] }, github: { issues: [pr] }, outlook: { messages: [] }, teams: { messages: [] } };
    clusterState = idleCluster({ jobs: [{ id: "J-7", name: "Morning refresh", queuedAt: now, doneAt: now + 1, nodes: 2 }] });
    await waitFor(() => expect([...collects].sort()).toEqual(["github", "outlook", "slack", "teams"]));
    await act(async () => {});
    expect(screen.getByRole("row", { name: "Saved during the refresh" })).toBeTruthy();
    expect(screen.queryByRole("row", { name: "Worker hands back its task" })).toBeNull();
  });

  it("stays busy while its job runs on the cluster", async () => {
    clusterState = idleCluster({ jobs: [{ id: "J-3", name: "Morning refresh", queuedAt: now, doneAt: null, nodes: null }] });
    await openToday();
    await waitFor(() => expect(screen.getByRole("button", { name: "Refreshing" }).hasAttribute("disabled")).toBe(true));
    clusterState = idleCluster({ jobs: [{ id: "J-3", name: "Morning refresh", queuedAt: now, doneAt: now + 9000, nodes: 2 }] });
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
  });

  it("ignores the r shortcut while typing", async () => {
    await openToday();
    await waitFor(() => expect(posts).toHaveLength(1));
    const input = document.createElement("input");
    document.body.append(input);
    fireEvent.keyDown(input, { key: "r" });
    await act(async () => {});
    expect(posts).toHaveLength(1);
    input.remove();
  });

  it("refreshes after five visible minutes, and waits while hidden", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openToday();
    await waitFor(() => expect(posts).toHaveLength(1));
    clusterState = idleCluster({ jobs: [{ id: "J-7", name: "Morning refresh", queuedAt: now, doneAt: now + 1, nodes: 2 }] });
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    expect(posts).toHaveLength(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    fireEvent(document, new Event("visibilitychange"));
    await waitFor(() => expect(posts).toHaveLength(2));
  });
});

describe("Today across pages", () => {
  const go = (name: string) => fireEvent.click(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name }));

  it("keeps an open Jira edit after a visit to another page", async () => {
    await openToday();
    fireEvent.click(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half written" } });
    go("Cluster");
    go("Today");
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Half written");
  });

  it("keeps an open Jira edit while the list is filtered to another source", async () => {
    await openToday();
    fireEvent.click(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "Half written" } });
    fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
    expect(screen.queryByRole("textbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("Half written");
  });

  it("refreshes on coming back after five minutes away", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openToday();
    await waitFor(() => expect(posts).toHaveLength(1));
    clusterState = idleCluster({ jobs: [{ id: "J-7", name: "Morning refresh", queuedAt: now, doneAt: now + 1, nodes: 2 }] });
    go("Cluster");
    await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
    const before = sourceGets("slack");
    expect(posts).toHaveLength(1);
    go("Today");
    await waitFor(() => expect(posts).toHaveLength(2));
    await waitFor(() => expect(sourceGets("slack")).toBe(before + 1));
  });

  it("keeps syncing the sources while the cluster is unreachable", async () => {
    clusterState = idleCluster({ jobs: [{ id: "J-3", name: "Morning refresh", queuedAt: now, doneAt: null, nodes: null }] });
    await openToday();
    await screen.findByRole("button", { name: "Refreshing" });
    clusterState = { error: "down" };
    expect(await screen.findByRole("button", { name: "Refresh" })).toBeTruthy();
    expect(screen.getByText("Cluster not reachable")).toBeTruthy();
  });
});

describe("Today summary", () => {
  it("counts open tasks and the ones waiting on you", async () => {
    await openToday();
    const stats = screen.getByRole("list", { name: "Summary" });
    expect(within(stats).getByText("Open tasks").parentElement?.textContent).toContain("4");
    expect(within(stats).getByText("Waiting on you").parentElement?.textContent).toContain("2");
  });

  it("filters the table by source and sorts it by time", async () => {
    await openToday();
    fireEvent.click(screen.getByRole("button", { name: /^Slack/ }));
    expect(rows().map((item) => item.getAttribute("aria-label"))).toEqual(["Can you look at the demo?", "@you the deploy failed"]);
    fireEvent.click(screen.getByRole("button", { name: /^All/ }));
    fireEvent.click(screen.getByRole("button", { name: "Sort by updated" }));
    expect(rows().map((item) => item.getAttribute("aria-label"))).toEqual(["@you the deploy failed", "Can you look at the demo?", "Worker hands back its task", "Snapshot the queue"]);
  });
});

describe("Today boards", () => {
  it("shows which board holds which step in words, and a step carried on from a dead board", async () => {
    const run = (worker: string, fields: Record<string, unknown>) => ({ worker, start: now - 4000, heardAt: now - 1000, end: null, from: 0, to: 0.5, outcome: "running", ...fields });
    clusterState = idleCluster({
      nodes: [node("Q-01", { role: "orchestrator" }), node("Q-02", { up: false, role: undefined })],
      tasks: [{ id: "T-2", input: "Fetch Slack messages", status: "claimed", worker: "Q-01", lostBy: ["Q-02"], job: "J-7", after: [], progress: 0.6, runs: [run("Q-02", { end: now - 3000, to: 0.4, outcome: "lost" }), run("Q-01", { from: 0.4, to: 0.6 })] }],
    });
    window.history.replaceState({}, "", "/cluster");
    render(<App />);
    const board = await screen.findByRole("row", { name: "Board 1" });
    expect(within(board).getByText("Orchestrator")).toBeTruthy();
    expect(within(board).getByText("Fetching Slack")).toBeTruthy();
    expect(within(board).getByText("Taken over from Board 2")).toBeTruthy();
    expect(within(screen.getByRole("row", { name: "Board 2" })).getByText("Down")).toBeTruthy();
  });
});

describe("Today Jira edits", () => {
  async function editDescription(text: string) {
    await openToday();
    fireEvent.click(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByRole("textbox"), { target: { value: text } });
  }

  it("only writes the fields that changed", async () => {
    await openToday();
    fireEvent.click(within(row("Worker hands back its task")).getByRole("button", { name: "Edit" }));
    expect(screen.getByRole("button", { name: "Save to Jira" }).hasAttribute("disabled")).toBe(true);
    fireEvent.change(screen.getByRole("textbox"), { target: { value: "New description" } });
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change to Jira" }));
    await waitFor(() => expect(posts).toContainEqual({ path: "/api/jira/issues/QT1S-31", body: { description: "New description" } }));
    expect(await screen.findByText("Saved to Jira.")).toBeTruthy();
  });

  it("doesn't write back a value a sync changed while editing", async () => {
    await editDescription("New description");
    jiraIssues = () => Response.json({ issues: [{ ...issue, storyPointEstimate: 5 }] });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));
    fireEvent.keyDown(window, { key: "r" });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Save 1 change to Jira" }));
    await waitFor(() => expect(posts.some((post) => post.path === "/api/jira/issues/QT1S-31")).toBe(true));
    expect(posts.find((post) => post.path === "/api/jira/issues/QT1S-31")?.body).toEqual({ description: "New description" });
  });

  it("keeps the list and an open edit when a sync fails", async () => {
    await editDescription("New description");
    jiraIssues = () => Response.json({ error: "Jira is down." }, { status: 502 });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText("Jira: Jira is down.")).toBeTruthy();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("New description");
    expect(rows()).toHaveLength(4);
  });
});
