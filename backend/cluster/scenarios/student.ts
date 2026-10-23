import { book, calendarPreview, freeSlots, groups, hm, listing, listPreview, outputsOf, pagePreview, plural, sentences, slotCells, slotText, WEEK, weekday } from "../plan.ts";
import type { Busy, Result, Scenario, Slot } from "../plan.ts";

// A college student's job hunt, on a demo inbox, calendar and canned company
// pages. Every company here is made up; the websites use the .example domain.

type Email = { id: number; from: string; domain: string; subject: string; body: string };
type Reply = { company: string; url: string; kind: "Interview request" | "Not moving forward" | "Update"; subject: string; minutes: number | null; window: "morning" | "afternoon" | null; days: string[] };
type Research = { company: string; url: string; about: string; prep: string[] };

const APPLIED = [
  { company: "Northwind Robotics", domain: "northwind-robotics.example" },
  { company: "Lumen Health", domain: "lumenhealth.example" },
  { company: "Cobalt Freight", domain: "cobaltfreight.example" },
  { company: "Fernway Analytics", domain: "fernway.example" },
  { company: "Halcyon Games", domain: "halcyongames.example" },
  { company: "Parcel & Pine", domain: "parcelandpine.example" },
  { company: "Tidewater Energy", domain: "tidewater.example" },
  { company: "Brightline Labs", domain: "brightlinelabs.example" },
];

// The six replies, where they sit in the inbox, and two that look like replies but are not.
const REPLIES: Record<number, Omit<Email, "id">> = {
  7: { from: "Dana Ortiz <recruiting@northwind-robotics.example>", domain: "northwind-robotics.example", subject: "Northwind Robotics: next steps on your application", body: "Thanks for applying to the Software Engineering Intern role. We'd love to set up a 45-minute interview with our autonomy team. Any afternoon next week works for us." },
  29: { from: "Halcyon Games Talent <talent@halcyongames.example>", domain: "halcyongames.example", subject: "Your application to Halcyon Games", body: "Thank you for your interest. Unfortunately we are not moving forward with your application at this time." },
  46: { from: "Priya Natarajan <priya@lumenhealth.example>", domain: "lumenhealth.example", subject: "Lumen Health interview: phone screen", body: "We enjoyed your application! Could we schedule a 30-minute phone screen? Tuesday or Wednesday works best for the team." },
  63: { from: "Fernway Analytics <hiring@fernway.example>", domain: "fernway.example", subject: "Technical interview invitation, Fernway Analytics", body: "You've been selected for a 60-minute technical interview. Our engineers are free in the morning, any day next week." },
  71: { from: "Leo Brandt <leo@quarrysystems.example>", domain: "quarrysystems.example", subject: "Quick chat about a role at Quarry Systems?", body: "I came across your profile and think you'd be a great fit. Do you have 20 minutes to talk?" },
  88: { from: "Parcel & Pine Careers <careers@parcelandpine.example>", domain: "parcelandpine.example", subject: "Interview: Parcel & Pine new grad engineer", body: "We'd like to invite you to a 45-minute interview with our platform team. Thursday or Friday next week, any time that suits you." },
  97: { from: "JobBoard Digest <digest@jobboard.example>", domain: "jobboard.example", subject: "New roles at Northwind Robotics, Lumen Health and more", body: "12 new internships match your saved search. Northwind Robotics is hiring. Lumen Health is hiring." },
  104: { from: "Cobalt Freight Recruiting <jobs@cobaltfreight.example>", domain: "cobaltfreight.example", subject: "Application received: Cobalt Freight", body: "Thanks for applying. Your application is under review and we will be in touch within two weeks." },
};

const NOISE = [
  ["CS 620 Staff <cs620@university.example>", "Milestone {n}: demo checklist posted"],
  ["Campus Rec <rec@university.example>", "Intramural volleyball schedule, week {n}"],
  ["Library <library@university.example>", "Your hold is ready for pickup ({n})"],
  ["Mom <mom@family.example>", "Did you call your grandmother? ({n})"],
  ["Bank Alerts <alerts@bank.example>", "Your statement is ready ({n})"],
  ["Robotics Club <club@university.example>", "Meeting notes, session {n}"],
  ["Food Delivery <orders@food.example>", "Your order #{n} is on its way"],
  ["Jamie <jamie@friends.example>", "Study group tonight? ({n})"],
  ["Career Center <careers@university.example>", "Resume workshop reminder ({n})"],
  ["Newsletter <weekly@techdigest.example>", "This week in tech, issue {n}"],
];

export const INBOX: Email[] = Array.from({ length: 120 }, (_, index) => {
  const id = index + 1;
  if (REPLIES[id]) return { id, ...REPLIES[id] };
  const [from, subject] = NOISE[id % NOISE.length];
  return { id, from, domain: from.split("@")[1].replace(">", ""), subject: subject.replace("{n}", String(id)), body: "" };
});

// The week of Oct 26: classes, a shift at the library, a dentist appointment.
const CALENDAR: Busy[] = WEEK.flatMap((day, index) => [
  ...(index % 2 === 0 ? [{ day, start: hm("09:30"), end: hm("10:45"), what: "CS 620 lecture" }] : [{ day, start: hm("11:00"), end: hm("12:15"), what: "Statistics" }]),
  { day, start: hm("12:15"), end: hm("13:00"), what: "Lunch" },
  ...(index === 1 || index === 3 ? [{ day, start: hm("14:00"), end: hm("16:00"), what: "Library shift" }] : []),
  ...(index === 2 ? [{ day, start: hm("15:30"), end: hm("16:30"), what: "Dentist" }] : []),
  ...(index === 4 ? [{ day, start: hm("13:00"), end: hm("15:00"), what: "Capstone team meeting" }] : []),
]);

// Canned copies of each company's site: what a fetch of its About and Careers pages would return.
const PAGES: Record<string, string> = {
  "northwind-robotics.example": "About: Northwind Robotics builds autonomous forklifts for mid-size warehouses. Product: Pathfinder, a navigation stack that maps a warehouse in under an hour. Values: safety first, ship weekly, own the outcome. News: Raised a Series B in September to expand into cold-storage warehouses. Interviews: a pairing exercise on a small planning problem in C++ or Python.",
  "lumenhealth.example": "About: Lumen Health makes a patient check-in app used by 400 clinics. Product: Lumen Front Desk, which replaces paper intake forms. Values: patients before features, privacy by default, kindness. News: Launched Spanish and Vietnamese intake forms last month. Interviews: a phone screen about a past project, then a take-home.",
  "fernway.example": "About: Fernway Analytics helps grocery chains predict demand for fresh produce. Product: Forecast, a dashboard that cuts food waste by suggesting order sizes. Values: measure twice, explain your numbers, leave it better. News: Partnered with a regional grocer to cut produce waste by 18 percent. Interviews: a live SQL and data-modeling session.",
  "parcelandpine.example": "About: Parcel & Pine runs same-day delivery for independent bookstores. Product: Shelf, a routing service that batches deliveries by neighborhood. Values: small shops matter, simple over clever, be on time. News: Expanded to three new cities this fall. Interviews: system design of a delivery scheduler, plus a culture chat.",
};

const FULL_DAY: Record<string, string> = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday" };

function classify(email: Email): Reply | null {
  const applied = APPLIED.find((entry) => entry.domain === email.domain);
  if (!applied) return null;
  const text = `${email.subject} ${email.body}`;
  const kind = /unfortunately|not moving forward/i.test(text) ? "Not moving forward" : /interview|phone screen|schedule/i.test(text) ? "Interview request" : "Update";
  const minutes = Number(text.match(/(\d+)-minute/)?.[1] ?? 0) || null;
  const window = /afternoon/i.test(text) ? "afternoon" : /morning/i.test(text) ? "morning" : null;
  const days = WEEK.filter((day) => new RegExp(FULL_DAY[weekday(day)], "i").test(text));
  return { company: applied.company, url: `https://${applied.domain}`, kind, subject: email.subject, minutes: kind === "Interview request" ? minutes : null, window, days };
}

const SLICES = [[1, 40], [41, 80], [81, 120]];

export const student: Scenario = {
  id: "student",
  audience: "Student",
  icon: "mail",
  title: "Find job replies, book interviews, prep",
  prompt: "Go through all my emails and see which jobs got back to me, look at my calendar and tell me when I should do these interviews, look at the companies' websites and prepare me for the interview.",
  data: {
    label: "Running on a demo inbox and calendar",
    items: ["Demo inbox: 120 emails, 8 applications sent", "Demo calendar: week of Oct 26", "Company websites: saved copies of made-up companies (.example)"],
  },
  stages: [
    {
      label: "Read the inbox",
      short: "Inbox",
      icon: "mail",
      plan: () =>
        SLICES.map(([from, to]) => ({
          skill: "inbox",
          instruction: `Read emails ${from}–${to} and find replies from companies you applied to`,
          label: `Emails ${from}–${to}`,
          icon: "mail" as const,
          preview: listPreview("inbox", INBOX.slice(from - 1, to).map((email): [string, string] => [email.from.split(" <")[0], email.subject])),
          params: { from, to },
          ms: 6500,
          meter: { verb: "Read", noun: "emails", total: to - from + 1 },
        })),
    },
    {
      label: "Research companies + find interview times",
      short: "Research + slots",
      icon: "globe",
      plan: (done) => {
        const interviews = outputsOf<{ replies: Reply[] }>(done, "inbox").flatMap((out) => out.replies).filter((reply) => reply.kind === "Interview request");
        return [
          ...groups(interviews, 3).map((group) => ({
            skill: "research",
            instruction: `Read ${listing(group.map((reply) => reply.url.replace("https://", "")))} and write what they do and what to prepare`,
            label: `${group.map((reply) => reply.company.split(" ")[0]).join(" + ")} site${group.length > 1 ? "s" : ""}`,
            icon: "globe" as const,
            preview: pagePreview("browser", group.map((reply) => ({ url: reply.url.replace("https://", ""), lines: sentences(PAGES[reply.url.replace("https://", "")] ?? "") }))),
            params: { companies: group.map(({ company, url }) => ({ company, url })) },
            ms: 5500,
            meter: { verb: "Read", noun: "websites", total: group.length },
            assign: "fresh" as const,
          })),
          ...[WEEK.slice(0, 3), WEEK.slice(3)].map((days) => ({
            skill: "calendar",
            instruction: `Find open time in your calendar ${weekday(days[0])}–${weekday(days.at(-1)!)}`,
            label: `${weekday(days[0])}–${weekday(days.at(-1)!)} slots`,
            icon: "calendar" as const,
            preview: calendarPreview(days, CALENDAR),
            params: { days },
            ms: 4000,
            meter: { verb: "Checked", noun: "days", total: days.length },
            assign: "previous" as const,
          })),
        ];
      },
    },
    {
      label: "Pick times and write prep briefs",
      short: "Briefs",
      icon: "doc",
      plan: (done) => [
        {
          skill: "brief",
          instruction: "Match each interview to an open slot and write a prep brief per company",
          label: "Times + briefs",
          icon: "doc",
          params: {
            replies: outputsOf<{ replies: Reply[] }>(done, "inbox").flatMap((out) => out.replies),
            research: outputsOf<Research[]>(done, "research").flat(),
            slots: outputsOf<Slot[]>(done, "calendar").flat(),
          },
          ms: 3500,
          role: "orchestrator",
        },
      ],
    },
  ],
  skills: {
    inbox: ({ from, to }: { from: number; to: number }) => {
      const replies = INBOX.slice(from - 1, to).flatMap((email) => classify(email) ?? []);
      const names = replies.map((reply) => `${reply.company} (${reply.kind === "Interview request" ? "interview" : reply.kind === "Update" ? "update" : "no"})`);
      const slice = INBOX.slice(from - 1, to);
      const found = {
        marks: slice.flatMap((email, row): Array<[number, string]> => {
          const reply = classify(email);
          return reply ? [[row, `${reply.company.split(" ")[0]} · ${reply.kind === "Interview request" ? "interview" : reply.kind === "Update" ? "update" : "no"}`]] : [];
        }),
        chips: replies.filter((reply) => reply.kind === "Interview request").map((reply) => reply.url.replace("https://", "")),
      };
      return { summary: replies.length ? `Found ${plural(replies.length, "reply", "replies")}: ${listing(names)}` : "No replies from companies you applied to", short: replies.length ? plural(replies.length, "reply", "replies") : "No replies", data: { read: to - from + 1, replies }, found };
    },
    research: ({ companies }: { companies: Array<{ company: string; url: string }> }) => {
      const data: Research[] = companies.map(({ company, url }) => {
        const page = PAGES[url.replace("https://", "")] ?? "";
        const field = (name: string) => page.match(new RegExp(`${name}: ([^.]+)\\.`))?.[1] ?? "";
        return {
          company,
          url,
          about: field("About"),
          prep: [
            `Know the product: ${field("Product")}.`,
            `Have a story for each value: ${field("Values")}.`,
            `Ask about the news: ${field("News")}.`,
            `Expect ${field("Interviews").replace(/^a /, "a ")}.`,
          ],
        };
      });
      const found = { pages: data.map((entry) => [entry.about, entry.prep[0].replace("Know the product: ", "Product: "), entry.prep[3]]) };
      return { summary: `Summarized ${listing(companies.map((entry) => entry.company))}`, short: `${plural(companies.length, "summary", "summaries")}`, data, found };
    },
    calendar: ({ days }: { days: string[] }) => {
      const slots = freeSlots(CALENDAR, days, 45);
      return { summary: `Found ${plural(slots.length, "open slot")}, ${weekday(days[0])}–${weekday(days.at(-1)!)}`, short: plural(slots.length, "slot"), data: slots, found: { slots: slotCells(slots, days) } };
    },
    brief: ({ replies, research, slots }: { replies: Reply[]; research: Research[]; slots: Slot[] }) => {
      const open = [...slots].sort((a, b) => a.day.localeCompare(b.day) || a.start - b.start);
      const times = new Map<string, string>();
      for (const reply of replies.filter((entry) => entry.kind === "Interview request")) {
        const slot = book(open, reply.minutes ?? 45, (chosen) => (!reply.days.length || reply.days.includes(chosen.day)) && (reply.window !== "morning" || chosen.end <= 12 * 60) && (reply.window !== "afternoon" || chosen.start >= 12 * 60));
        times.set(reply.company, slot ? slotText(slot) : "No open time fits; ask for other options");
      }
      const interviews = replies.filter((reply) => reply.kind === "Interview request");
      const booked = interviews.filter((reply) => !times.get(reply.company)!.startsWith("No open")).length;
      const result: Result = {
        headline: `${plural(replies.length, "company", "companies")} replied and ${interviews.length} want an interview. ${booked === interviews.length ? "Every interview fits your week." : `${booked} of them fit your week.`}`,
        stats: [
          { value: String(replies.length), label: "replied" },
          { value: String(interviews.length), label: "want an interview" },
          { value: booked === interviews.length ? "All" : String(booked), label: "fit your week" },
        ],
        sections: [
          {
            title: "Companies that replied",
            kind: "table",
            columns: ["Company", "Reply", "Suggested interview time"],
            rows: replies.map((reply) => [reply.company, reply.kind, times.get(reply.company) ?? "—"]),
          },
          {
            title: "Prep briefs",
            kind: "cards",
            cards: research.map((entry) => ({ title: entry.company, subtitle: `${entry.about}. ${times.get(entry.company) ?? ""}`, lines: entry.prep })),
          },
        ],
      };
      return { summary: `Booked ${plural(times.size, "interview")} and wrote ${plural(research.length, "brief")}`, short: "Briefs ✓", data: result };
    },
  },
};
