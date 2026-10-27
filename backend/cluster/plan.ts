// What a scenario is made of, and small helpers the scenarios share.
//
// A scenario is data: a demo dataset, a list of stages and the skills its steps
// use. Each stage turns the outputs of the steps before it into the next steps,
// with a plain-English instruction for the board that runs each one. The queue
// runs every stage function on every node in the same order, so they must be
// pure: no clock, no randomness, only the steps' outputs and the dataset.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// How a step's progress reads while it runs: "Read 23 of 40 emails".
export type Meter = { verb: string; noun: string; total: number };

// The pictures a step or stage can carry. The page draws each as an icon with its own tint.
export type Icon = "mail" | "globe" | "calendar" | "doc" | "slack" | "jira" | "github" | "log" | "diff" | "reply" | "list" | "resume" | "rank" | "invoice" | "chat" | "merge" | "search" | "paper";

// A small picture of a step's real input, drawn under the board doing it: rows of
// a list (emails, resumes, invoices, messages), pages of text (a website, a
// paper, a log, a draft), or a week of calendar blocks.
export type Preview =
  | { kind: "list"; look: "inbox" | "resume" | "invoice" | "chat" | "items" | "search"; rows: Array<[string, string]> }
  | { kind: "page"; look: "browser" | "paper" | "log" | "doc"; pages: Array<{ url: string; lines: string[] }> }
  | { kind: "calendar"; days: string[]; busy: Array<[number, number, number]> };

// What a step found, to light up its preview: matching rows with a tag, link
// chips it pulled out, a few bullets per page, open calendar slots.
export type Found = { marks?: Array<[number, string]>; chips?: string[]; pages?: string[][]; slots?: Array<[number, number, number]> };

export type StepSpec = {
  skill: string;
  // What the board is told, in full, and the 2–4 words drawn on the chip that carries it.
  instruction: string;
  label: string;
  icon: Icon;
  preview?: Preview;
  params: Json;
  // How long the step takes at normal pace, so a person can watch it happen.
  ms: number;
  meter?: Meter;
  // Steps only the orchestrator runs: planning, merging, ranking.
  role?: "orchestrator";
  // Who should get it: the boards that ran the stage before, or the ones that did not.
  assign?: "previous" | "fresh";
};

// summary is the sentence; short is the 1–3 words on the chip that flies back ("3 replies").
export type StepOutput = { summary: string; short: string; data: Json; found?: Found };

// A finished step, as the next stage sees it.
export type DoneStep = { skill: string; stage: number; params: Json; output: StepOutput; worker: string };

// prompt is what the person asked for; only a scenario that works from it needs it.
export type Stage = { label: string; short: string; icon: Icon; plan: (done: DoneStep[], prompt: string) => StepSpec[] };

// The result a scenario ends with, drawn the same way for every scenario.
export type Section =
  | { title: string; kind: "table"; columns: string[]; rows: string[][] }
  | { title: string; kind: "list"; items: string[] }
  | { title: string; kind: "text"; body: string }
  | { title: string; kind: "cards"; cards: Array<{ title: string; subtitle: string; lines: string[] }> };
export type Result = { headline: string; stats: Array<{ value: string; label: string }>; sections: Section[] };

export type Scenario = {
  id: string;
  // Who it is for in a word or two, and the job in one line.
  audience: string;
  icon: Icon;
  title: string;
  prompt: string;
  // What the demo data is, said plainly so nobody mistakes it for theirs.
  data: { label: string; items: string[] };
  stages: Stage[];
  // Each skill turns a step's params into its output. The final stage's single step returns a Result as its data.
  // Most skills read the scenario's canned dataset; the live one calls the model, so a skill may take its time.
  skills: Record<string, (params: any) => StepOutput | Promise<StepOutput>>;
};

// The outputs of one skill, in the order the steps were made.
export function outputsOf<T = any>(done: DoneStep[], skill: string): T[] {
  return done.filter((step) => step.skill === skill).map((step) => step.output.data as T);
}

// Splits items into at most n groups of near-equal size, in order.
export function groups<T>(items: T[], n: number): T[][] {
  const count = Math.min(n, items.length);
  return Array.from({ length: count }, (_, index) => items.filter((_, at) => at % count === index));
}

// "Northwind, Lumen and Cobalt".
export function listing(names: string[]): string {
  return names.length < 2 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

// A fixed pseudo-random sequence, so generated demo data is the same on every node and every run.
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

// Calendars. Times are minutes from midnight on a "YYYY-MM-DD" day.
export type Busy = { day: string; start: number; end: number; what: string };
export type Slot = { day: string; start: number; end: number };

export const WEEK = ["2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"];
const DAY_NAMES: Record<string, string> = { "2026-10-26": "Mon Oct 26", "2026-10-27": "Tue Oct 27", "2026-10-28": "Wed Oct 28", "2026-10-29": "Thu Oct 29", "2026-10-30": "Fri Oct 30" };
export const dayName = (day: string) => DAY_NAMES[day] ?? day;
export const weekday = (day: string) => dayName(day).slice(0, 3);

export function clock(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${((hour + 11) % 12) + 1}:${String(minute).padStart(2, "0")} ${hour < 12 ? "AM" : "PM"}`;
}

export const slotText = (slot: Slot) => `${dayName(slot.day)}, ${clock(slot.start)}–${clock(slot.end)}`;
export const hm = (text: string) => Number(text.split(":")[0]) * 60 + Number(text.split(":")[1]);

// The open stretches of at least `min` minutes between 9 and 5 on each day, given every busy block.
export function freeSlots(busy: Busy[], days: string[], min = 30, open = 9 * 60, close = 17 * 60): Slot[] {
  return days.flatMap((day) => {
    const blocks = busy.filter((block) => block.day === day).sort((a, b) => a.start - b.start);
    const slots: Slot[] = [];
    let from = open;
    for (const block of blocks) {
      if (block.start - from >= min) slots.push({ day, start: from, end: Math.min(block.start, close) });
      from = Math.max(from, block.end);
    }
    if (close - from >= min) slots.push({ day, start: from, end: close });
    return slots;
  });
}

// Books `minutes` in the first open slot that passes `fits`, leaving 15 minutes either
// side, and takes it out of the open slots so the next booking cannot overlap it.
export function book(slots: Slot[], minutes: number, fits: (slot: Slot) => boolean = () => true): Slot | null {
  for (const [index, slot] of slots.entries()) {
    const start = slot.start === 9 * 60 ? slot.start : slot.start + 15;
    // Start on the hour or half hour, like a person would.
    const rounded = Math.ceil(start / 30) * 30;
    const chosen = { day: slot.day, start: rounded, end: rounded + minutes };
    if (chosen.end > slot.end || !fits(chosen)) continue;
    slots.splice(index, 1, { day: slot.day, start: slot.start, end: rounded - 15 }, { day: slot.day, start: chosen.end + 15, end: slot.end });
    return chosen;
  }
  return null;
}

// Previews, built from a step's real input.
export const listPreview = (look: Extract<Preview, { kind: "list" }>["look"], rows: Array<[string, string]>): Preview => ({ kind: "list", look, rows });
export const pagePreview = (look: Extract<Preview, { kind: "page" }>["look"], pages: Array<{ url: string; lines: string[] }>): Preview => ({ kind: "page", look, pages });
export const calendarPreview = (days: string[], busy: Busy[]): Preview => ({
  kind: "calendar",
  days: days.map(weekday),
  busy: busy.filter((block) => days.includes(block.day)).map((block) => [days.indexOf(block.day), block.start, block.end]),
});
// The open slots, as calendar-preview cells.
export const slotCells = (slots: Slot[], days: string[]): Array<[number, number, number]> => slots.filter((slot) => days.includes(slot.day)).map((slot) => [days.indexOf(slot.day), slot.start, slot.end]);
// A sentence split into short lines for a page preview.
export const sentences = (text: string) => text.split(/(?<=\.)\s+/).filter(Boolean);
