import { book, calendarPreview, freeSlots, groups, hm, listing, listPreview, outputsOf, pagePreview, plural, seeded, slotCells, slotText, WEEK, weekday } from "../plan.ts";
import type { Busy, Result, Scenario, Slot } from "../plan.ts";

// A hiring manager screening applicants for a backend role. The 60 applicants
// are generated from a fixed seed: made-up people with made-up portfolios.

type Applicant = { id: number; name: string; years: number; skills: string[]; handle: string };
type Scored = { id: number; name: string; score: number; reasons: string[] };
type Portfolio = { name: string; notes: string };

// What the job asks for, and how much each counts.
const WANTS: Record<string, number> = { Go: 3, Postgres: 3, "distributed systems": 2, Kubernetes: 1, "REST APIs": 1, mentoring: 1 };
const ALL_SKILLS = [...Object.keys(WANTS), "Java", "React", "Python", "AWS", "Rust", "GraphQL", "Kafka"];

const FIRST = ["Ava", "Ben", "Chloe", "Dev", "Elif", "Femi", "Gia", "Hiro", "Isla", "Jon", "Kemi", "Luca", "Mei", "Nadia", "Omar", "Pia", "Quinn", "Rosa", "Sven", "Tara"];
const LAST = ["Abara", "Brooks", "Castillo", "Dang", "Eriksen", "Farah", "Greer", "Haddad", "Ito", "Jansen", "Kowalski", "Lindqvist"];

const random = seeded(620);
export const APPLICANTS: Applicant[] = Array.from({ length: 60 }, (_, index) => {
  const name = `${FIRST[index % FIRST.length]} ${LAST[(index * 7) % LAST.length]}`;
  const skills = ALL_SKILLS.filter(() => random() < 0.38);
  return { id: index + 1, name, years: 1 + Math.floor(random() * 9), skills, handle: name.toLowerCase().replace(" ", "-") };
});

// What each applicant's GitHub or portfolio page shows, generated from their skills.
function portfolioPage(applicant: Applicant): string {
  const repos = 4 + (applicant.id * 5) % 23;
  const pinned = applicant.skills.includes("Go") ? "a Raft-backed key-value store in Go" : applicant.skills.includes("Postgres") ? "a Postgres migration tool" : "a personal website";
  const recent = applicant.id % 3 === 0 ? "No commits in the last 6 months" : `Committed ${8 + (applicant.id % 30)} times last month`;
  return `${repos} public repos. Pinned: ${pinned}. ${recent}.`;
}

// Three interviewers' calendars for the week of Oct 26.
const PANEL = ["Alex (EM)", "Priya (Staff Eng)", "Jordan (Eng)"];
const PANEL_BUSY: Busy[] = WEEK.flatMap((day, index) => [
  { day, start: hm("09:00"), end: hm("10:00"), what: "Alex: team standup and 1:1s" },
  { day, start: hm(index % 2 ? "13:00" : "11:00"), end: hm(index % 2 ? "14:30" : "12:30"), what: "Priya: design review" },
  ...(index === 2 ? [{ day, start: hm("10:00"), end: hm("17:00"), what: "Jordan: on call" }] : [{ day, start: hm("15:30"), end: hm("16:30"), what: "Jordan: sprint planning" }]),
]);

function score(applicant: Applicant): Scored {
  const matched = applicant.skills.filter((skill) => WANTS[skill]);
  const points = matched.reduce((sum, skill) => sum + WANTS[skill], 0) + Math.min(applicant.years, 8) * 0.5;
  const reasons = [...matched.sort((a, b) => WANTS[b] - WANTS[a]).slice(0, 3), `${plural(applicant.years, "year")} experience`];
  return { id: applicant.id, name: applicant.name, score: Math.round(points * 10) / 10, reasons };
}

const BATCHES = groups(APPLICANTS.map((applicant) => applicant.id), 4).map((ids) => ids.sort((a, b) => a - b));

export const hiring: Scenario = {
  id: "hiring",
  audience: "Hiring manager",
  icon: "resume",
  title: "Screen 60 applicants, book interviews",
  prompt: "Screen the 60 applicants for the backend role, shortlist the top 5 and set up interviews.",
  data: {
    label: "Running on 60 demo applicants and a demo interview panel",
    items: ["Demo applicants: 60 made-up resumes for a Backend Engineer (Go, Postgres) role", "Portfolios: generated GitHub pages for each applicant", "Panel calendars: 3 interviewers, week of Oct 26"],
  },
  stages: [
    {
      label: "Score resumes in batches",
      short: "Score",
      icon: "resume",
      plan: () =>
        BATCHES.map((ids, index) => ({
          skill: "score",
          instruction: `Score resumes batch ${index + 1} (${ids.length} applicants) against the job description`,
          label: `Resumes batch ${index + 1}`,
          icon: "resume" as const,
          preview: listPreview("resume", ids.map((id): [string, string] => {
            const applicant = APPLICANTS.find((entry) => entry.id === id)!;
            return [applicant.name, `${applicant.years} yrs · ${applicant.skills.slice(0, 3).join(", ") || "no listed skills"}`];
          })),
          params: { ids },
          ms: 6000,
          meter: { verb: "Scored", noun: "resumes", total: ids.length },
        })),
    },
    {
      label: "Merge and shortlist the top 5",
      short: "Shortlist",
      icon: "rank",
      plan: (done) => [{ skill: "shortlist", instruction: "Merge the 4 batches, rank all 60 and pick the top 5", label: "Rank all 60", icon: "rank", params: { scored: outputsOf<Scored[]>(done, "score").flat() }, ms: 2500, role: "orchestrator" }],
    },
    {
      label: "Check portfolios + find panel times",
      short: "Check + slots",
      icon: "github",
      plan: (done) => {
        const top = outputsOf<Scored[]>(done, "shortlist")[0];
        return [
          ...groups(top, 3).map((group) => ({ skill: "portfolio", instruction: `Check the GitHub pages of ${listing(group.map((entry) => entry.name))}`, label: `${group.map((entry) => entry.name.split(" ")[0]).join(" + ")} GitHub`, icon: "github" as const, preview: pagePreview("browser", group.map((entry) => {
            const applicant = APPLICANTS.find((candidate) => candidate.id === entry.id)!;
            return { url: `github.example/${applicant.handle}`, lines: portfolioPage(applicant).split(". ") };
          })), params: { ids: group.map((entry) => entry.id) }, ms: 5000, meter: { verb: "Checked", noun: "portfolios", total: group.length }, assign: "fresh" as const })),
          ...[WEEK.slice(0, 3), WEEK.slice(3)].map((days) => ({ skill: "panel", instruction: `Find times ${weekday(days[0])}–${weekday(days.at(-1)!)} when all 3 interviewers are free for an hour`, label: `Panel ${weekday(days[0])}–${weekday(days.at(-1)!)}`, icon: "calendar" as const, preview: calendarPreview(days, PANEL_BUSY), params: { days }, ms: 4500, meter: { verb: "Checked", noun: "days", total: days.length }, assign: "previous" as const })),
        ];
      },
    },
    {
      label: "Write the shortlist and schedule",
      short: "Schedule",
      icon: "doc",
      plan: (done) => [{ skill: "final", instruction: "Write the shortlist with reasons and book an interview for each", label: "Shortlist + times", icon: "doc", params: { top: outputsOf<Scored[]>(done, "shortlist")[0], portfolios: outputsOf<Portfolio[]>(done, "portfolio").flat(), slots: outputsOf<Slot[]>(done, "panel").flat() }, ms: 3000, role: "orchestrator" }],
    },
  ],
  skills: {
    score: ({ ids }: { ids: number[] }) => {
      const scored = APPLICANTS.filter((applicant) => ids.includes(applicant.id)).map(score).sort((a, b) => b.score - a.score);
      const top = new Set(scored.slice(0, 3).map((entry) => entry.id));
      const marks = ids.map((id, row): [number, string] => [row, `${scored.find((entry) => entry.id === id)!.score}${top.has(id) ? " ★" : ""}`]);
      return { found: { marks }, summary: `Scored ${ids.length}; best: ${scored[0].name} (${scored[0].score})`, short: `${ids.length} scored`, data: scored };
    },
    shortlist: ({ scored }: { scored: Scored[] }) => {
      const top = [...scored].sort((a, b) => b.score - a.score || a.name.localeCompare(b.name)).slice(0, 5);
      return { summary: `Top 5 of ${scored.length}: ${listing(top.map((entry) => entry.name))}`, short: "Top 5", data: top };
    },
    portfolio: ({ ids }: { ids: number[] }) => {
      const data: Portfolio[] = ids.map((id) => {
        const applicant = APPLICANTS.find((entry) => entry.id === id)!;
        return { name: applicant.name, notes: `github.example/${applicant.handle}: ${portfolioPage(applicant)}` };
      });
      return { found: { pages: data.map((entry) => [entry.notes.split(": ")[1].split(". ")[1] ?? "", entry.notes.split(". ").at(-1) ?? ""]) }, summary: `Checked ${listing(data.map((entry) => entry.name))}`, short: `${plural(data.length, "profile")} checked`, data };
    },
    panel: ({ days }: { days: string[] }) => {
      const slots = freeSlots(PANEL_BUSY, days, 60);
      return { found: { slots: slotCells(slots, days) }, summary: `${plural(slots.length, "window")} when all 3 are free, ${weekday(days[0])}–${weekday(days.at(-1)!)}`, short: plural(slots.length, "slot"), data: slots };
    },
    final: ({ top, portfolios, slots }: { top: Scored[]; portfolios: Portfolio[]; slots: Slot[] }) => {
      const open = [...slots].sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
      const times = top.map((entry) => book(open, 60));
      const result: Result = {
        headline: `Shortlisted 5 of 60. ${top[0].name} leads with ${top[0].score} points; ${times.every(Boolean) ? "all 5 have" : `${times.filter(Boolean).length} have`} a panel interview booked.`,
        stats: [
          { value: "60", label: "screened" },
          { value: "5", label: "shortlisted" },
          { value: String(times.filter(Boolean).length), label: "interviews booked" },
        ],
        sections: [
          {
            title: "Shortlist",
            kind: "table",
            columns: ["#", "Candidate", "Score", "Why", "Portfolio"],
            rows: top.map((entry, index) => [String(index + 1), entry.name, String(entry.score), entry.reasons.join(", "), portfolios.find((page) => page.name === entry.name)?.notes ?? "—"]),
          },
          {
            title: "Proposed interviews",
            kind: "table",
            columns: ["Candidate", "Time", "Panel"],
            rows: top.map((entry, index) => [entry.name, times[index] ? slotText(times[index]!) : "No common hour left this week", PANEL.join(", ")]),
          },
        ],
      };
      return { summary: `Shortlist written and ${plural(times.filter(Boolean).length, "interview")} booked`, short: "Shortlist ✓", data: result };
    },
  },
};
