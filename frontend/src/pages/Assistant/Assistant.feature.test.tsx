import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import App from "../../App";

const now = 1_000_000;
const node = (id: string, fields: Record<string, unknown> = {}) => ({ id, up: true, member: true, role: "worker", term: 2, votes: [], members: ["Q-01", "Q-02", "Q-03", "Q-04"], commitIndex: 9, lastIndex: 9, ...fields });
const run = (worker: string, fields: Record<string, unknown> = {}) => ({ worker, start: now - 4000, heardAt: now - 500, end: null, from: 0, to: 0.5, outcome: "running", ...fields });
const step = (id: string, input: string, fields: Record<string, unknown> = {}) => ({ id, input, status: "queued", worker: null, lostBy: [], job: "J-4", after: [], progress: 0, runs: [], skill: "inbox", stage: 0, output: null, assignee: null, label: input, icon: "mail", ...fields });

const stages = [
  { label: "Read the inbox", short: "Inbox", icon: "mail" },
  { label: "Research companies + find interview times", short: "Research + slots", icon: "globe" },
  { label: "Pick times and write prep briefs", short: "Briefs", icon: "doc" },
];
const scenarios = [
  { id: "student", audience: "Student", icon: "mail", title: "Find job replies, book interviews, prep", prompt: "Go through all my emails and see which jobs got back to me.", data: { label: "Running on a demo inbox and calendar", items: ["Demo inbox: 120 emails"] }, stages },
  { id: "engineer", audience: "Engineer", icon: "github", title: "Catch up on Slack, Jira and GitHub", prompt: "Catch me up on everything since yesterday.", data: { label: "Running on demo Slack, Jira and GitHub data", items: [] }, stages: [{ label: "Read Slack, Jira and GitHub", short: "Read all", icon: "slack" }] },
];

const plan = (fields: Record<string, unknown> = {}) => ({ id: "J-4", name: "Job hunt", queuedAt: now - 20_000, doneAt: null, nodes: null, plan: { scenario: "student", prompt: scenarios[0].prompt, pace: 1, stage: 1, stages, result: null, ...fields } });

// Mid-run: the inbox is read, Board 3 is reading websites, and Board 4 died holding a calendar step that Board 2 took over.
const midRun = () => [
  step("T-1", "Read emails 1–40 and find replies from companies you applied to", { label: "Emails 1–40", status: "done", progress: 1, runs: [run("Q-02", { end: now - 9000, to: 1, outcome: "done" })], output: { summary: "Found 2 replies", short: "2 replies", data: null } }),
  step("T-2", "Read northwind-robotics.example and write what they do and what to prepare", { label: "Northwind site", icon: "globe", preview: { kind: "page", look: "browser", pages: [{ url: "northwind-robotics.example", lines: ["About: autonomous forklifts."] }, { url: "parcelandpine.example", lines: ["About: delivery."] }] }, status: "claimed", worker: "Q-03", stage: 1, skill: "research", progress: 0.5, meter: { verb: "Read", noun: "websites", total: 2 }, runs: [run("Q-03", { start: now - 3000 })] }),
  step("T-3", "Find open time in your calendar Mon–Wed", { label: "Mon–Wed slots", icon: "calendar", status: "claimed", worker: "Q-02", stage: 1, skill: "calendar", lostBy: ["Q-04"], progress: 0.6, meter: { verb: "Checked", noun: "days", total: 3 }, runs: [run("Q-04", { end: now - 2500, to: 0.4, outcome: "lost" }), run("Q-02", { start: now - 1000, from: 0.4, to: 0.6 })] }),
];

function cluster(fields: Record<string, unknown> = {}) {
  return {
    tasks: midRun(),
    jobs: [plan()],
    workers: [],
    terms: [{ term: 2, orchestrator: "Q-01", at: now - 60_000 }],
    events: [],
    now,
    auto: true,
    maxNodes: 6,
    orchestrator: "Q-01",
    term: 2,
    members: ["Q-01", "Q-02", "Q-03", "Q-04"],
    nodes: [node("Q-01", { role: "orchestrator" }), node("Q-02"), node("Q-03"), node("Q-04", { up: false, role: undefined })],
    ...fields,
  };
}

function mock(state: unknown) {
  const posts: Array<[string, unknown]> = [];
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = String(url);
    if (init?.method === "POST") {
      posts.push([path, JSON.parse(String(init.body))]);
      return Response.json({ job: { id: "J-9" } }, { status: 201 });
    }
    if (path.endsWith("/api/assistant/scenarios")) return Response.json({ scenarios });
    const source = path.match(/\/api\/(jira|slack|github)\/connection$/)?.[1];
    if (source) return Response.json({ [source]: { configured: false, connected: false, enabled: false } });
    return Response.json(state);
  }));
  window.history.replaceState({}, "", "/assistant");
  render(<App />);
  return posts;
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
});

describe("Assistant: ask", () => {
  it("opens on an empty page asking what the boards should do, with an example job per audience, marked as demo data", async () => {
    mock(cluster({ jobs: [], tasks: [] }));
    expect(await screen.findByRole("heading", { name: "What should your boards do?" })).toBeTruthy();
    await screen.findByRole("button", { name: /Engineer/ });
    expect(within(screen.getByRole("navigation", { name: "Pages" })).getByRole("link", { name: "Assistant" }).getAttribute("aria-current")).toBe("page");
    expect((screen.getByRole("textbox", { name: "Job" }) as HTMLTextAreaElement).value).toBe(scenarios[0].prompt);
    expect(screen.getByText("Running on a demo inbox and calendar")).toBeTruthy();
    expect(screen.getAllByText("Demo data")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: /Engineer/ }));
    expect((screen.getByRole("textbox", { name: "Job" }) as HTMLTextAreaElement).value).toBe(scenarios[1].prompt);
    expect(screen.queryByRole("list", { name: "Plan" })).toBeNull();
  });

  it("runs the picked job with its prompt and speed", async () => {
    const posts = mock(cluster({ jobs: [], tasks: [] }));
    fireEvent.click(await screen.findByRole("button", { name: /Engineer/ }));
    fireEvent.change(screen.getByLabelText("Speed"), { target: { value: "slow" } });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await act(async () => {});
    expect(posts).toEqual([["/api/assistant/run", { scenario: "engineer", prompt: scenarios[1].prompt, pace: "slow" }]]);
  });

  it("sends one job however often Run is clicked while the server answers", async () => {
    const posts: unknown[] = [];
    let answer = () => {};
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST") {
        posts.push(path);
        await new Promise<void>((resolve) => (answer = resolve));
        return Response.json({ job: { id: "J-9" } }, { status: 201 });
      }
      if (path.endsWith("/api/assistant/scenarios")) return Response.json({ scenarios });
      const source = path.match(/\/api\/(jira|slack|github)\/connection$/)?.[1];
      if (source) return Response.json({ [source]: { configured: false, connected: false, enabled: false } });
      return Response.json(cluster({ jobs: [], tasks: [] }));
    }));
    window.history.replaceState({}, "", "/assistant");
    render(<App />);
    await screen.findByRole("button", { name: /Engineer/ });
    await waitFor(() => expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);
    await act(async () => answer());
    expect(posts).toEqual(["/api/assistant/run"]);
  });
});

describe("Assistant: watch", () => {
  it("shows the phase, a one-line narration, and each board's chip and count in a few words", async () => {
    mock(cluster());
    const stage = await screen.findByRole("region", { name: "Cluster" });
    expect(screen.getByRole("list", { name: "Plan" }).querySelector("[aria-current=step]")?.textContent).toBe("Research + slots");
    const orchestrator = within(stage).getByLabelText("Orchestrator");
    expect(orchestrator.textContent).toContain("Split into 2 · 0 back");
    // Its list of pieces says who has each.
    const pieces = within(orchestrator).getByRole("list", { name: "Pieces" });
    expect(within(pieces).getByText("Northwind site").parentElement?.textContent).toContain("→ B3");
    expect(within(pieces).getByText("Mon–Wed slots").parentElement?.textContent).toContain("→ B2");

    const board3 = within(stage).getByRole("group", { name: "Board 3" });
    expect(within(board3).getByText("Northwind site")).toBeTruthy();
    expect(within(board3).getByText("Reading websites · 1/2")).toBeTruthy();
    // Its sketch shows the real page it is on: the second of two at 50%.
    expect(board3.querySelector(".preview .url")?.textContent).toBe("parcelandpine.example");
    expect(board3.getAttribute("title")).toBe("Read northwind-robotics.example and write what they do and what to prepare");

    // Board 4 died holding a step; Board 2 has it now.
    const board4 = within(stage).getByRole("group", { name: "Board 4" });
    expect(within(board4).getByText("Mon–Wed slots")).toBeTruthy();
    expect(within(board4).getByText("Down · given to Board 2")).toBeTruthy();
    expect(within(within(stage).getByRole("group", { name: "Board 2" })).getByText("Checking days · 1/3")).toBeTruthy();
    // The narration follows the cluster's clock, which it picks up a moment after the first poll.
    await waitFor(() => expect(stage.querySelector(".narration")?.textContent).toBe("Orchestrator gave Board 4's Mon–Wed slots to Board 2"));
  });

  it("restarts a dead board from its card, and stops the job", async () => {
    const posts = mock(cluster());
    const stage = await screen.findByRole("region", { name: "Cluster" });
    fireEvent.click(within(within(stage).getByRole("group", { name: "Board 4" })).getByRole("button", { name: "Restart" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => {});
    expect(posts).toEqual([["/api/cluster/nodes/Q-04/start", {}], ["/api/assistant/stop", { job: "J-4" }]]);
  });

  it("keeps the log folded until asked for", async () => {
    mock(cluster());
    fireEvent.click(await screen.findByRole("button", { name: /Show log/ }));
    const log = screen.getByRole("list", { name: "Log" });
    expect(within(log).getByText("Board 2 sent back “2 replies”")).toBeTruthy();
    expect(within(log).getByText("Orchestrator gave Board 4's “Mon–Wed slots” to Board 2")).toBeTruthy();
  });

  it("warns when the cluster stops answering mid-job, and keeps the last state", async () => {
    let up = true;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith("/api/assistant/scenarios")) return Response.json({ scenarios });
      const source = path.match(/\/api\/(jira|slack|github)\/connection$/)?.[1];
      if (source) return Response.json({ [source]: { configured: false, connected: false, enabled: false } });
      return up ? Response.json(cluster()) : Response.json({}, { status: 503 });
    }));
    window.history.replaceState({}, "", "/assistant");
    render(<App />);
    await screen.findByRole("region", { name: "Cluster" });
    up = false;
    expect(await screen.findByText("The cluster is not reachable. Showing the last received state.")).toBeTruthy();
    expect(screen.getByRole("region", { name: "Cluster" })).toBeTruthy();
  });

  it("while the boards elect a new orchestrator, says so", async () => {
    mock(cluster({ orchestrator: null, nodes: [node("Q-01", { up: false }), node("Q-02", { role: "candidate" }), node("Q-03")] }));
    const stage = await screen.findByRole("region", { name: "Cluster" });
    expect(stage.querySelector(".narration")?.textContent).toBe("Orchestrator died. Boards are electing a new one…");
    expect(within(stage).getByLabelText("Orchestrator").textContent).toContain("Electing…");
    expect(within(within(stage).getByRole("group", { name: "Board 2" })).getByText("Voting")).toBeTruthy();
  });
});

describe("Assistant: report", () => {
  const result = {
    headline: "6 companies replied and 4 want an interview.",
    stats: [{ value: "6", label: "replied" }, { value: "4", label: "want an interview" }, { value: "All", label: "fit your week" }],
    sections: [
      { title: "Companies that replied", kind: "table", columns: ["Company", "Reply", "Suggested interview time"], rows: [["Northwind Robotics", "Interview request", "Mon Oct 26, 1:30 PM–2:15 PM"]] },
      { title: "Prep briefs", kind: "cards", cards: [{ title: "Northwind Robotics", subtitle: "Autonomous forklifts", lines: ["Know the product: Pathfinder.", "Ask about the news."] }] },
    ],
  };

  it("opens empty even when an earlier job has finished", async () => {
    mock(cluster({ jobs: [{ ...plan({ stage: 2, result }), doneAt: now - 1000, nodes: 3 }] }));
    expect(await screen.findByRole("heading", { name: "What should your boards do?" })).toBeTruthy();
  });

  it("still shows the report of a job followed to another page and back", async () => {
    let state = cluster();
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      const path = String(url);
      if (path.endsWith("/api/assistant/scenarios")) return Response.json({ scenarios });
      const source = path.match(/\/api\/(jira|slack|github)\/(connection|activity)$/);
      if (source?.[2] === "connection") return Response.json({ [source[1]]: { configured: false, connected: false, enabled: false } });
      if (source) return Response.json({ events: [] });
      return Response.json(state);
    }));
    window.history.replaceState({}, "", "/assistant");
    render(<App />);
    await screen.findByRole("region", { name: "Cluster" });
    const nav = within(screen.getByRole("navigation", { name: "Pages" }));
    fireEvent.click(nav.getByRole("link", { name: "Cluster" }));
    state = cluster({ jobs: [{ ...plan({ stage: 2, result }), doneAt: now - 1000, nodes: 3 }] });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 600)); });
    fireEvent.click(nav.getByRole("link", { name: "Assistant" }));
    expect(await screen.findByText("6 companies replied and 4 want an interview.")).toBeTruthy();
  });

  it("leads with a headline and stat tiles, puts each section in a tab, and goes back to ask for another", async () => {
    let state = cluster({ jobs: [], tasks: [] });
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (init?.method === "POST") {
        state = cluster({ jobs: [{ ...plan({ stage: 2, result }), doneAt: now - 1000, nodes: 3 }] });
        return Response.json({ job: { id: "J-4" } }, { status: 201 });
      }
      if (path.endsWith("/api/assistant/scenarios")) return Response.json({ scenarios });
      const source = path.match(/\/api\/(jira|slack|github)\/connection$/)?.[1];
      if (source) return Response.json({ [source]: { configured: false, connected: false, enabled: false } });
      return Response.json(state);
    }));
    window.history.replaceState({}, "", "/assistant");
    render(<App />);
    await screen.findByRole("button", { name: /Engineer/ });
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(await screen.findByText("6 companies replied and 4 want an interview.")).toBeTruthy();
    const tiles = screen.getByRole("list", { name: "Summary" });
    expect(within(tiles).getByText("fit your week")).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Mon Oct 26, 1:30 PM–2:15 PM" })).toBeTruthy();
    fireEvent.click(screen.getByRole("tab", { name: "Prep briefs" }));
    expect(screen.getByText("Know the product: Pathfinder.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Run another job" }));
    expect(screen.getByRole("heading", { name: "What should your boards do?" })).toBeTruthy();
  });
});
