import { describe, expect, it } from "vitest";
import type { ClusterState, Job, Task } from "../Cluster/cluster";
import { caption, eventsOf, ing, narrate } from "./story";

const run = (worker: string, fields: Record<string, unknown> = {}) => ({ worker, start: 0, heardAt: 0, end: null, from: 0, to: 0, outcome: "running", ...fields });
const task = (fields: Record<string, unknown>) => ({ id: "T-1", input: "Read emails 1–40", label: "Emails 1–40", icon: "mail", status: "claimed", worker: "Q-02", lostBy: [], job: "J-1", after: [], progress: 0.5, stage: 0, runs: [], ...fields }) as unknown as Task;
const job = { id: "J-1", name: "Job hunt", queuedAt: 0, doneAt: null, nodes: null, plan: { scenario: "student", prompt: "", pace: 1, stage: 0, stages: [{ label: "Read the inbox", short: "Inbox", icon: "mail" }], result: null } } as Job;
const cluster = { orchestrator: "Q-01", terms: [], nodes: [] } as unknown as ClusterState;

describe("story", () => {
  it("captions a step by its meter: Reading emails · 23/40", () => {
    expect(ing("Read")).toBe("Reading");
    expect(ing("Checked")).toBe("Checking");
    expect(ing("Scored")).toBe("Scoring");
    expect(caption(task({ progress: 0.58, meter: { verb: "Read", noun: "emails", total: 40 } }))).toBe("Reading emails · 23/40");
    expect(caption(task({ progress: 0.4 }))).toBe("Working · 40%");
  });

  it("does not call a board picking its own step back up a handover", () => {
    const again = task({ status: "done", output: { summary: "", short: "2 replies", data: null }, lostBy: ["Q-02"], runs: [run("Q-02", { start: 10, outcome: "lost", end: 100 }), run("Q-02", { start: 120, end: 900, outcome: "done" })] });
    const events = eventsOf(job, [again], cluster);
    expect(events.map((event) => event.kind)).toEqual(["back", "out", "plan"]);
  });

  it("narrates a handover first, then the steady state", () => {
    // Down at 1 s, noticed by the orchestrator at 2.5 s, given to Board 3 at 3 s.
    const lost = task({ worker: "Q-02", runs: [run("Q-02", { start: 0 })] });
    const down = { ...cluster, nodes: [{ id: "Q-02", up: false }] } as unknown as ClusterState;
    expect(narrate(job, [lost], down, eventsOf(job, [lost], down), 1500)).toBe("Board 2 went down holding Emails 1–40");
    const back = task({ status: "queued", worker: null, lostBy: ["Q-02"], runs: [run("Q-02", { outcome: "lost", end: 1000, lostAt: 2500 })] });
    expect(narrate(job, [back], down, eventsOf(job, [back], down), 2700)).toBe("Orchestrator noticed Board 2 stopped responding");
    const moved = task({ worker: "Q-03", lostBy: ["Q-02"], runs: [run("Q-02", { outcome: "lost", end: 1000, lostAt: 2500 }), run("Q-03", { start: 3000 })] });
    const events = eventsOf(job, [moved], cluster);
    expect(narrate(job, [moved], cluster, events, 4000)).toBe("Orchestrator gave Board 2's Emails 1–40 to Board 3");
    expect(narrate(job, [moved], cluster, events, 9000)).toBe("Board 3 on inbox");
  });
});
