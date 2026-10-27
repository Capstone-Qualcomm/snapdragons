import assert from "node:assert/strict";
import { test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import type { Result } from "./plan.ts";
import { book, freeSlots, groups } from "./plan.ts";
import { createQueue } from "./queue.ts";
import type { ClaimResult, Job, Task } from "./queue.ts";
import { ask } from "./scenarios/ask.ts";
import { readFileSync } from "node:fs";
import { entriesOf, hedge, shortlist, toCentral } from "./scenarios/interviews.ts";
import type { Busy, Role } from "./services.ts";
import { runSkill, SCENARIOS } from "./scenarios/index.ts";

// The demo scenarios run offline on canned data; the live ones call the model, so their pure parts are tested on their own below.
const DEMOS = SCENARIOS.filter((scenario) => !/^Live/.test(scenario.data.label));

// A queue fed commands the way Raft feeds it, with boards that run each step's
// real skill on the scenario's demo data. Q-01 starts as the orchestrator.
function cluster(scenario: string, boards = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05"]) {
  const queue = createQueue();
  let at = 0;
  const run = (type: string, fields: Record<string, unknown> = {}) => queue.apply({ type, at: (at += 10), ...fields });
  run("noop", { term: 1, orchestrator: boards[0] });
  for (const board of boards) run("claim", { worker: board });
  const job = run("plan", { scenario, prompt: "test", pace: 1 }) as Job;
  const holding = new Map<string, Task>();
  const up = new Set(boards);

  const claim = (board: string) => {
    const { task } = run("claim", { worker: board }) as ClaimResult;
    if (task) holding.set(board, task);
    return task;
  };
  const finish = (board: string) => {
    const task = holding.get(board)!;
    holding.delete(board);
    return run("complete", { worker: board, task: task.id, output: runSkill(scenario, task.skill!, task.params) });
  };
  // One round: every idle board asks for work, then every busy one finishes.
  const round = () => {
    for (const board of up) if (!holding.has(board)) claim(board);
    for (const board of [...holding.keys()]) finish(board);
  };
  const plan = () => queue.state().jobs.find((entry) => entry.id === job.id)!;
  const tasks = () => queue.state().tasks.filter((task) => task.job === job.id);
  const toEnd = () => {
    for (let n = 0; n < 50 && plan().doneAt === null; n++) round();
    assert.ok(plan().doneAt !== null, "the plan finishes");
    return plan().plan!.result as Result;
  };
  return {
    run,
    claim,
    finish,
    round,
    plan,
    tasks,
    toEnd,
    holding,
    // A board losing power: the orchestrator notices and its step goes back in the queue.
    kill: (board: string) => {
      up.delete(board);
      holding.delete(board);
      run("expire", { worker: board });
    },
    elect: (board: string, term: number) => run("noop", { term, orchestrator: board }),
  };
}

const rows = (result: Result, title: string) => (result.sections.find((section) => section.title === title) as { rows: string[][] }).rows;

test("a plan fans out its first stage, and the next waits until every step of it is done", () => {
  const c = cluster("student");
  assert.deepEqual(c.tasks().map((task) => task.input), [
    "Read emails 1–40 and find replies from companies you applied to",
    "Read emails 41–80 and find replies from companies you applied to",
    "Read emails 81–120 and find replies from companies you applied to",
  ]);
  // Each goes to a different board, and none to the orchestrator.
  assert.deepEqual(c.tasks().map((task) => task.assignee), ["Q-02", "Q-03", "Q-04"]);
  assert.equal(c.claim("Q-01"), null);

  c.claim("Q-02");
  c.claim("Q-03");
  c.claim("Q-04");
  c.finish("Q-02");
  c.finish("Q-03");
  assert.equal(c.tasks().length, 3);
  assert.equal(c.plan().plan!.stage, 0);
  c.finish("Q-04");
  // Four companies want interviews: three research steps go to the board that read nothing, then on; two calendar steps to the inbox readers.
  const second = c.tasks().filter((task) => task.stage === 1);
  assert.deepEqual(second.map((task) => task.skill), ["research", "research", "research", "calendar", "calendar"]);
  assert.equal(second[0].assignee, "Q-05");
  assert.ok(["Q-02", "Q-03", "Q-04"].includes(second[3].assignee!));
});

test("a step a dead board held goes to another board and keeps its checkpoint", () => {
  const c = cluster("student");
  c.claim("Q-02");
  c.run("progress", { worker: "Q-02", task: "T-1", progress: 0.5 });
  c.kill("Q-02");
  // Q-05 has nothing of its own, so it takes the orphaned step.
  const task = c.claim("Q-05")!;
  assert.equal(task.id, "T-1");
  assert.equal(task.progress, 0.5);
  assert.deepEqual(task.lostBy, ["Q-02"]);
  c.toEnd();
});

test("an idle board takes a step waiting on a busy one", () => {
  const c = cluster("student", ["Q-01", "Q-02"]);
  c.claim("Q-02");
  // Only one other board, so all three inbox steps were handed to it, and it is busy with the first.
  assert.equal(c.claim("Q-01"), null, "the orchestrator still does not read the inbox while a worker is up");
  c.kill("Q-02");
  assert.equal(c.claim("Q-01")?.skill, "inbox", "with no worker left, the orchestrator does the work itself");
});

test("a new orchestrator picks up the plan, including a merge the old one was writing", () => {
  const c = cluster("student");
  const workers = ["Q-02", "Q-03", "Q-04", "Q-05"];
  while (!c.tasks().some((task) => task.role === "orchestrator")) {
    for (const board of workers) if (!c.holding.has(board)) c.claim(board);
    for (const board of [...c.holding.keys()]) c.finish(board);
  }
  // Stage 3: only the orchestrator may write the briefs.
  const merge = c.tasks().find((task) => task.role === "orchestrator")!;
  assert.equal(c.claim("Q-02"), null);
  assert.equal(c.claim("Q-01")?.id, merge.id);
  // Q-01 dies mid-merge; Q-03 wins the election and, once Q-01 is expired, takes the merge over.
  c.elect("Q-03", 2);
  c.kill("Q-01");
  assert.equal(c.claim("Q-02"), null);
  assert.equal(c.claim("Q-03")?.id, merge.id);
  c.finish("Q-03");
  assert.ok(c.plan().doneAt !== null);
  assert.deepEqual(c.tasks().find((task) => task.id === merge.id)!.lostBy, ["Q-01"]);
});

test("student: finds the six replies, books four interviews that fit, and writes four briefs", () => {
  const c = cluster("student");
  c.round();
  c.kill("Q-03");
  const result = c.toEnd();
  assert.deepEqual(rows(result, "Companies that replied"), [
    ["Northwind Robotics", "Interview request", "Mon Oct 26, 1:30 PM–2:15 PM"],
    ["Halcyon Games", "Not moving forward", "—"],
    ["Lumen Health", "Interview request", "Tue Oct 27, 9:00 AM–9:30 AM"],
    ["Fernway Analytics", "Interview request", "Mon Oct 26, 11:00 AM–12:00 PM"],
    ["Parcel & Pine", "Interview request", "Thu Oct 29, 9:00 AM–9:45 AM"],
    ["Cobalt Freight", "Update", "—"],
  ]);
  const briefs = result.sections.find((section) => section.kind === "cards") as { cards: Array<{ title: string; lines: string[] }> };
  assert.deepEqual(briefs.cards.map((card) => card.title).sort(), ["Fernway Analytics", "Lumen Health", "Northwind Robotics", "Parcel & Pine"]);
  assert.match(briefs.cards.find((card) => card.title === "Northwind Robotics")!.lines[0], /Pathfinder/);
  assert.match(result.headline, /Every interview fits your week/);
});

test("engineer: ranks Priya's blocking review first and explains the failing CI", () => {
  const c = cluster("engineer");
  c.round();
  c.elect("Q-02", 2);
  c.kill("Q-01");
  const result = c.toEnd();
  const todo = rows(result, "What to do first");
  assert.equal(todo[0][1], "Review PR #212 (Retry card authorizations with backoff)");
  assert.equal(todo[1][1], "Unblock your PR #208");
  assert.match(todo[1][2], /test database container did not start/);
  assert.equal(todo.length, 7);
  // Priya, Jordan and Alex get drafts; the latency alert from Ops Bot does not.
  assert.deepEqual((result.sections.find((section) => section.title === "Drafted replies") as { cards: Array<{ title: string }> }).cards.map((card) => card.title).sort(), ["Alex Kim", "Jordan Lee", "Priya Raman"]);
});

test("the model's answer counts in any of the shapes it uses", () => {
  const one = { id: 77, kind: "application", candidate: "Maya Nasser" };
  assert.deepEqual(entriesOf(JSON.stringify({ emails: [one] })), [one]);
  assert.deepEqual(entriesOf(JSON.stringify(one)), [one], "one email, answered with its object alone");
  assert.deepEqual(entriesOf("```json\n" + JSON.stringify([one]) + "\n```"), [one]);
  assert.deepEqual(entriesOf("Here you go: " + JSON.stringify({ emails: [one] })), [one]);
});

test("a slow model call is sent again, and the first answer wins", async () => {
  let calls = 0;
  const slowThenFast = () => (++calls === 1 ? new Promise<string>((resolve) => setTimeout(() => resolve("slow"), 300)) : Promise.resolve("fast"));
  assert.equal(await hedge(slowThenFast, 50), "fast");
  calls = 0;
  assert.equal(await hedge(() => Promise.resolve(`answer ${++calls}`), 50), "answer 1", "a quick answer is not sent twice");
  await sleep(80);
  assert.equal(calls, 1);
  let tries = 0;
  assert.equal(await hedge(() => (++tries === 1 ? Promise.reject(new Error("boom")) : Promise.resolve("retried")), 1000), "retried", "a failure is retried at once");
});

test("interviews: times given in another zone move to Central in code, day included", () => {
  assert.deepEqual(toCentral({ day: "2026-11-04", start: "00:00", end: "02:00", utcOffset: 9 }), { day: "2026-11-03", start: "09:00", end: "11:00" });
  assert.deepEqual(toCentral({ day: "2026-11-05", start: "23:00", end: "01:00", utcOffset: 9 }), { day: "2026-11-05", start: "08:00", end: "10:00" });
  assert.deepEqual(toCentral({ day: "2026-11-03", start: "13:00", end: "17:00", utcOffset: -6 }), { day: "2026-11-03", start: "13:00", end: "17:00" });
  assert.deepEqual(toCentral({ day: "2026-11-03", start: "13:00", end: "17:00" }), { day: "2026-11-03", start: "13:00", end: "17:00" }, "Central when the zone is not given");
});

test("interviews: merges what the boards read into applicants, and books the best inside their times and the panel's", () => {
  const date = (day: number) => `2026-10-${day}T10:00:00-05:00`;
  const app = (id: number, name: string, fit: number, day: number, availability: Array<{ day: string; start: string; end: string }> = []) =>
    ({ id, kind: "application" as const, date: date(day), from: name, candidate: name, email: `${name.split(" ")[0].toLowerCase()}@school.edu`, school: "UW", year: "junior", skills: ["Go"], fit, why: "Go services", availability });
  const seen = [
    app(1, "Ada Byte", 9, 20, [{ day: "2026-11-03", start: "10:00", end: "12:00" }]),
    app(2, "Ada Byte", 7, 22),
    app(3, "Ben Late", 10, 26, [{ day: "2026-11-02", start: "10:00", end: "17:00" }]),
    app(4, "Cy Quit", 9, 21, [{ day: "2026-11-02", start: "10:00", end: "17:00" }]),
    // The model often leaves the student out of a withdrawal; the sender's address still says who it is.
    { id: 5, kind: "withdrawal" as const, date: date(25), from: "C. Quit", sender: "cy@school.edu" },
    app(6, "Di Reply", 8, 21),
    { id: 7, kind: "availability" as const, date: date(25), from: "Di Reply", candidate: "Di Reply", email: "di@school.edu", availability: [{ day: "2026-11-04", start: "09:00", end: "11:00" }] },
    { id: 8, kind: "referral" as const, date: date(22), from: "Marcus Lee", candidate: "Di Reply", email: "di@school.edu" },
    app(9, "Eve Nofit", 3, 21),
  ];
  const { busy, emails: _emails, ...role } = JSON.parse(readFileSync(new URL("./scenarios/data/interviews.json", import.meta.url), "utf8")) as Role & { busy: Busy[]; emails: unknown[] };
  const { applicants, picks } = shortlist(seen, role, busy);
  assert.equal(applicants.length, 5, "Ada applied twice and counts once");
  assert.ok(applicants.find((entry) => entry.name === "Ben Late")!.late);
  assert.deepEqual(picks.map((pick) => pick.applicant.name), ["Ada Byte", "Di Reply", "Eve Nofit"], "the late and the withdrawn are left out, best first");
  assert.deepEqual(picks[1].applicant.referredBy, ["Marcus Lee"]);
  assert.equal(picks[2].slot, null, "no times given, so nothing is booked");
  const minutes = (text: string) => Number(text.slice(0, 2)) * 60 + Number(text.slice(3));
  for (const { applicant, slot } of picks.slice(0, 2)) {
    assert.ok(slot, `${applicant.name} is booked`);
    assert.ok(applicant.availability.some((window) => window.day === slot.day && minutes(window.start) <= slot.start && slot.end <= minutes(window.end)), "inside the student's times");
    for (const who of ["Dana Whitfield", slot.with]) {
      assert.ok(busy.filter((block) => block.who === who && block.day === slot.day).every((block) => slot.end <= minutes(block.start) || slot.start >= minutes(block.end)), `${who} is free`);
    }
  }
});

test("business: finds the five unpaid invoices and groups complaints by theme", () => {
  const c = cluster("business");
  c.round();
  c.kill("Q-04");
  const result = c.toEnd();
  const overdue = rows(result, "Overdue invoices");
  assert.deepEqual(overdue.map((row) => row[1]).sort(), ["INV-1043", "INV-1049", "INV-1051", "INV-1055", "INV-1061", "INV-1064"]);
  assert.equal(overdue.find((row) => row[1] === "INV-1051")![2], "$100");
  assert.deepEqual(rows(result, "What customers are unhappy about").map((row) => [row[0], row[1]]), [["Late delivery", "4"], ["Wrong order", "2"], ["Price increase", "2"]]);
});

test("research: dedupes ten results to six papers, reads one per board, and compares them", () => {
  const c = cluster("research");
  const result = c.toEnd();
  assert.equal(c.tasks().filter((task) => task.skill === "summarize").length, 6);
  const table = rows(result, "How they compare");
  assert.equal(table.length, 6);
  assert.equal(table[0][0], "TinyConformer: Streaming ASR Under 10M Parameters");
  assert.match(result.headline, /SpikeASR is the fastest/);
});

test("every scenario's plan shape is different", () => {
  // "3 | 3+2 | 1": steps per stage, split by kind of step.
  const shapes = DEMOS.map((scenario) => {
    const c = cluster(scenario.id);
    c.toEnd();
    return [...new Set(c.tasks().map((task) => task.stage))]
      .map((stage) => {
        const kinds = c.tasks().filter((task) => task.stage === stage).map((task) => task.skill);
        return [...new Set(kinds)].map((kind) => kinds.filter((entry) => entry === kind).length).join("+");
      })
      .join(" | ");
  });
  assert.equal(new Set(shapes).size, DEMOS.length, shapes.join(" "));
});

test("Stop drops a plan's unfinished steps and ends it, and a board finishing one late changes nothing", () => {
  const c = cluster("student");
  c.claim("Q-02");
  const job = c.plan();
  c.run("cancel", { job: job.id });
  assert.equal(c.plan().plan!.error, "Stopped before it finished.");
  assert.ok(c.plan().doneAt !== null);
  assert.deepEqual(c.tasks(), []);
  assert.equal(c.finish("Q-02"), null);
  assert.equal(c.run("cancel", { job: job.id }), null);
});

test("every step has a 2–4 word label and an icon, and every result a short caption and stats", () => {
  for (const scenario of DEMOS) {
    const c = cluster(scenario.id);
    const result = c.toEnd();
    for (const task of c.tasks()) {
      assert.ok(task.label && task.label.split(" ").length <= 4, `${scenario.id}: "${task.label}"`);
      assert.ok(task.icon);
      assert.ok(task.output!.short.split(" ").length <= 4, `${scenario.id}: "${task.output!.short}"`);
    }
    assert.equal(result.stats.length, 3);
    assert.ok(scenario.stages.every((stage) => stage.short.split(" ").length <= 3));
  }
});

test("every board's step carries a picture of its real input, and its findings point into it", () => {
  for (const scenario of DEMOS) {
    const c = cluster(scenario.id);
    c.toEnd();
    for (const task of c.tasks().filter((entry) => entry.role !== "orchestrator")) {
      const preview = task.preview!;
      assert.ok(preview, `${scenario.id} ${task.skill} has a preview`);
      const found = task.output!.found ?? {};
      if (preview.kind === "list") {
        assert.ok(preview.rows.length > 0);
        for (const [row] of found.marks ?? []) assert.ok(row >= 0 && row < preview.rows.length, `${scenario.id} ${task.skill} mark ${row}`);
      }
      if (preview.kind === "page") assert.equal((found.pages ?? preview.pages).length, preview.pages.length, `${scenario.id} ${task.skill}`);
      if (preview.kind === "calendar") for (const [day] of found.slots ?? []) assert.ok(day < preview.days.length);
    }
  }
  // The student's inbox: the first slice marks Northwind's interview and Halcyon's no.
  const c = cluster("student");
  c.round();
  const first = c.tasks()[0];
  assert.deepEqual(first.output!.found!.marks, [[6, "Northwind · interview"], [28, "Halcyon · no"]]);
  assert.deepEqual(first.output!.found!.chips, ["northwind-robotics.example"]);
});

test("a board's heartbeats keep what it has found and done so far, and a heartbeat without them keeps the last", () => {
  const c = cluster("student");
  const task = c.claim("Q-02")!;
  c.run("progress", { worker: "Q-02", task: task.id, progress: 0.2, found: { marks: [[6, "Northwind · interview"]] }, partial: { read: [1] } });
  c.run("progress", { worker: "Q-02", task: task.id, progress: 0.4, found: { marks: [[6, "Northwind · interview"], [8, "Lumen · offer"]] }, partial: { read: [1, 2] } });
  c.run("progress", { worker: "Q-02", task: task.id, progress: 0.5 });
  const stored = c.tasks().find((entry) => entry.id === task.id)!;
  assert.deepEqual(stored.found, { marks: [[6, "Northwind · interview"], [8, "Lumen · offer"]] });
  assert.deepEqual(stored.partial, { read: [1, 2] });
});

test("calendar helpers find open time and never double-book it", () => {
  const busy = [{ day: "2026-10-26", start: 600, end: 660, what: "class" }];
  assert.deepEqual(freeSlots(busy, ["2026-10-26"], 45), [{ day: "2026-10-26", start: 540, end: 600 }, { day: "2026-10-26", start: 660, end: 1020 }]);
  const open = freeSlots([], ["2026-10-26"], 45);
  const first = book(open, 60)!;
  const second = book(open, 60)!;
  assert.ok(second.start >= first.end + 15);
  assert.deepEqual(groups([1, 2, 3, 4, 5], 2), [[1, 3, 5], [2, 4]]);
});

test("the live job works one part per board from the model's plan, and still answers when the plan fails", () => {
  const [planStage, workStage, combineStage] = ask.stages;
  const prompt = "Plan a weekend in Chicago";
  assert.equal(planStage.plan([], prompt)[0].role, "orchestrator");
  const parts = Array.from({ length: 7 }, (_, n) => ({ label: `Part ${n + 1}`, instruction: `Do part ${n + 1}` }));
  const planned = { skill: "plan", stage: 0, params: { prompt }, worker: "q-a", output: { summary: "", short: "", data: { parts } } };
  const steps = workStage.plan([planned], prompt);
  assert.equal(steps.length, 5, "at most five parts, so the model is not swamped");
  assert.ok(steps.every((step) => step.skill === "work" && !step.role && step.label.split(" ").length <= 4));
  // A plan the model botched still leaves one part: the whole job.
  const failed = { ...planned, output: { summary: "Failed", short: "Failed", data: null } };
  assert.deepEqual(workStage.plan([failed], prompt).map((step) => step.instruction), [prompt]);
  const worked = { skill: "work", stage: 1, params: null, worker: "q-b", output: { summary: "", short: "", data: { label: "Food", bullets: ["Deep dish"], text: "" } } };
  assert.equal(combineStage.plan([planned, worked], prompt)[0].role, "orchestrator");
});
