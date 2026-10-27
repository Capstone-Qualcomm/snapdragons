import { complete, jsonFrom } from "../llm.ts";
import { clock, groups, hm, listPreview, outputsOf, pagePreview, plural } from "../plan.ts";
import type { Found, Json, Result, Scenario, SkillContext } from "../plan.ts";
import { query } from "../services.ts";
import type { Busy, Email, Role } from "../services.ts";

// A hiring manager's real-sized week: a long, messy demo inbox (applications with resumes,
// availability replies, withdrawals, referrals, a duplicate, a phishing email and plenty of
// noise) and the interview panel's calendar. The mail, calendar and hiring req live on the
// gateway (services.ts); the boards query them like real systems. The orchestrator opens the
// inbox, each board fetches and reads its share of the emails with the model, the orchestrator
// ranks who they found and books interviews around the calendar, and the boards write the invites.

type Head = Omit<Email, "body" | "attachments"> & { attachments: string[] };
type Window = { day: string; start: string; end: string };
// "unread" is an email the model failed on every try: not finished, and never mistaken for noise.
type Kind = "application" | "availability" | "followup" | "withdrawal" | "referral" | "suspicious" | "other" | "unread";
// What a board took from one email.
type Seen = { id: number; kind: Kind; date: string; from: string; sender?: string; candidate?: string; email?: string; school?: string; year?: string; skills?: string[]; fit?: number; why?: string; availability?: Window[] };
type Applicant = { name: string; email: string; school: string; year: string; skills: string[]; fit: number; why: string; applied: string; emails: number[]; availability: Window[]; referredBy: string[]; withdrew: boolean; late: boolean };
type Booking = { day: string; start: number; end: number; with: string };
type Pick = { applicant: Applicant; slot: Booking | null };
type Draft = { name: string; to: string; subject: string; body: string; slot: Booking | null };

const INTERVIEW_MIN = 45;
const SHORTLIST = 6;
// One share of the inbox per board. With six boards, the orchestrator plans and the other five read.
const SHARES = 5;
const first = (name: string) => name.split(" ")[0];
// "Tue, Nov 3", from the date alone, so every node writes the same.
const dayName = (day: string) => new Date(`${day}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const when = (slot: Booking) => `${dayName(slot.day)}, ${clock(slot.start)}–${clock(slot.end)} Central`;

// ---- Reading: a board reads its emails four at a time, two batches at once, and says after each how far it is.

const readSystem = (role: Role) => `You read a hiring manager's inbox for a demo. The manager is ${role.manager.name} (${role.manager.title}, ${role.company}), hiring for: ${role.role}. The job: ${role.job}
For each email, decide its kind: "application" (a student applying; read the resume attachment), "availability" (a student giving interview times), "followup" (a student only checking on their application), "withdrawal" (a student pulling out), "referral" (a coworker recommending a student), "suspicious" (only phishing: an email that wants a password, bank details or a click on an outside link, often from a look-alike domain; ordinary spam, alerts and internal notices are "other", and mail from @${role.manager.email.split("@")[1]} pointing at its own sites is never phishing), or "other".
Interviews are next week, ${role.week[0]} to ${role.week.at(-1)}. Give availability exactly as the email states it, in the sender's own time zone, as {"day":"YYYY-MM-DD","start":"HH:MM","end":"HH:MM","utcOffset":-6} in 24-hour time, where utcOffset is that zone's offset from UTC in hours (US Central is -6 that week, Korea is 9). Do not convert; a window past midnight keeps its end time as written.
For an application, rate fit for this job from 1 (no match) to 10 (excellent), judging the resume, and say why in under 14 words.
Reply with JSON only: {"emails":[{"id":1,"kind":"application","candidate":"Full Name","email":"student@school.edu","school":"...","year":"junior","skills":["Go","Postgres"],"fit":8,"why":"...","availability":[]}]}
For "other" and "suspicious" give only id, kind and a "why" of a few words. For a referral, candidate and email are the student being referred.`;

function asText(email: Email): string {
  const attachments = (email.attachments ?? []).map((file) => `\n[Attachment: ${file.name}]\n${file.text}`).join("\n");
  return `### Email ${email.id}\nFrom: ${email.from.name} <${email.from.email}>\nDate: ${email.date}\nSubject: ${email.subject}\n\n${email.body}${attachments}`;
}

// A time as the email gave it, moved to US Central (UTC-6 that week) in code, since the model
// gets the hour right but not the day: midnight Wednesday in Seoul is 9am Tuesday in Madison.
// A window that runs past Central midnight is cut there.
export function toCentral(said: Window & { utcOffset?: number }): Window | null {
  if (!/^\d{4}-\d\d-\d\d$/.test(said.day) || !/^\d\d:\d\d$/.test(said.start) || !/^\d\d:\d\d$/.test(said.end)) return null;
  const offset = Number.isFinite(said.utcOffset) ? Number(said.utcOffset) : -6;
  const midnight = Date.parse(`${said.day}T00:00:00Z`);
  const start = midnight + (hm(said.start) - offset * 60) * 60_000;
  let end = midnight + (hm(said.end) - offset * 60) * 60_000;
  if (end <= start) end += 86_400_000;
  const central = (utc: number) => new Date(utc - 6 * 3_600_000);
  const from = central(start);
  const to = central(end);
  const sameDay = to.toISOString().slice(0, 10) === from.toISOString().slice(0, 10);
  const time = (date: Date) => date.toISOString().slice(11, 16);
  return { day: from.toISOString().slice(0, 10), start: time(from), end: sameDay ? time(to) : "23:59" };
}

const validWindow = (role: Role) => (window: Window | null): window is Window => !!window && role.week.includes(window.day) && hm(window.end) > hm(window.start);

// The model now and then takes a minute and a half on one call. If an answer has not come in
// afterMs, the same request goes out again and whichever answers first wins.
export function hedge<T>(run: () => Promise<T>, afterMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    let started = 0;
    let failed = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const go = () => {
      started++;
      run().then((value) => {
        clearTimeout(timer);
        resolve(value);
      }, (cause) => {
        if (++failed === 2) reject(cause);
        else if (started === 1) {
          clearTimeout(timer);
          go();
        }
      });
    };
    go();
    timer = setTimeout(go, afterMs);
  });
}

// What the model said about each email. Asked about one email it often answers with that
// email's object alone, and sometimes with a bare list, so all three shapes count.
export function entriesOf(reply: string): Array<Partial<Seen>> {
  const fenced = reply.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    parsed = jsonFrom(reply);
  }
  const value = parsed as { emails?: unknown; id?: unknown };
  if (Array.isArray(value)) return value;
  if (Array.isArray(value.emails)) return value.emails;
  return value.id === undefined ? [] : [value as Partial<Seen>];
}

async function readBatch(role: Role, ids: number[], tries = 3): Promise<Seen[]> {
  const emails = await Promise.all(ids.map((id) => query<Email>(`/mail/messages/${id}`)));
  for (let attempt = 1; ; attempt++) {
    try {
      const reply = await hedge(() => complete([{ role: "system", content: readSystem(role) }, { role: "user", content: emails.map(asText).join("\n\n") }], 2400), 20_000);
      const read = entriesOf(reply);
      // The model sometimes skips an email in a batch; those get read again on their own.
      const skipped = emails.filter((email) => !read.some((entry) => Number(entry.id) === email.id)).map((email) => email.id);
      const again = skipped.length && tries > 1 ? await Promise.all(skipped.map((id) => readBatch(role, [id], tries - 1))) : [];
      return emails.map((email) => {
        const seen = read.find((entry) => Number(entry.id) === email.id) ?? again.flat().find((entry) => entry.id === email.id) ?? { kind: "other" as const, why: "not answered" };
        return { ...seen, id: email.id, date: email.date, from: email.from.name, sender: email.from.email, kind: (seen.kind ?? "other") as Kind, availability: (seen.availability ?? []).map(toCentral).filter(validWindow(role)) };
      });
    } catch (cause) {
      if (attempt >= tries) return emails.map((email) => ({ id: email.id, kind: "unread" as const, date: email.date, from: email.from.name, sender: email.from.email, why: (cause as Error).message }));
    }
  }
}

function tag(seen: Seen): string | null {
  if (seen.kind === "application") return `${first(seen.candidate ?? seen.from)} · fit ${seen.fit ?? "?"}`;
  if (seen.kind === "availability") return `${first(seen.candidate ?? seen.from)} · times`;
  if (seen.kind === "followup") return `${first(seen.candidate ?? seen.from)} · follow-up`;
  if (seen.kind === "withdrawal") return `${first(seen.candidate ?? seen.from)} · withdrew`;
  if (seen.kind === "referral") return `referral · ${first(seen.candidate ?? "?")}`;
  if (seen.kind === "suspicious") return "phishing";
  if (seen.kind === "unread") return "could not read";
  return null;
}

async function read({ ids, role }: { ids: number[]; role: Role }, { partial, report }: SkillContext) {
  // A board taking this slice over from one that died keeps what that board had already read,
  // and tries again on any email it could not.
  const seen: Seen[] = ((partial as { seen?: Seen[] } | null)?.seen ?? []).filter((entry) => entry.kind !== "unread");
  const batches = groups(ids.filter((id) => !seen.some((entry) => entry.id === id)), Math.ceil(ids.filter((id) => !seen.some((entry) => entry.id === id)).length / 4));
  const marks = (): Found => ({ marks: ids.flatMap((id, row): Array<[number, string]> => {
    const label = seen.find((entry) => entry.id === id);
    const text = label && tag(label);
    return text ? [[row, text]] : [];
  }) });
  report(seen.length / ids.length, marks(), { seen: [...seen] } as unknown as Json);
  let next = 0;
  await Promise.all([0, 1].map(async () => {
    while (next < batches.length) {
      seen.push(...(await readBatch(role, batches[next++])));
      report(seen.length / ids.length, marks(), { seen: [...seen] } as unknown as Json);
    }
  }));
  const applicants = seen.filter((entry) => entry.kind === "application");
  const best = [...applicants].sort((a, b) => (b.fit ?? 0) - (a.fit ?? 0))[0];
  return {
    found: marks(),
    summary: `${plural(ids.length, "email")}: ${plural(applicants.length, "applicant")}${best ? `, best ${best.candidate} (${best.fit})` : ""}`,
    short: plural(applicants.length, "applicant"),
    data: seen as unknown as Json,
  };
}

// ---- Shortlisting and booking: plain code on the orchestrator, over what the boards found.

const key = (text?: string) => (text ?? "").trim().toLowerCase();

export function shortlist(seen: Seen[], role: Role, busy: Busy[]): { applicants: Applicant[]; picks: Pick[] } {
  const byKey = new Map<string, Applicant>();
  // A student's own emails are matched by their address, which the model can leave out but the inbox always has.
  // A referral comes from a coworker, so only the student it names counts.
  const find = (entry: Seen) => {
    const own = entry.kind !== "referral";
    const addresses = [entry.email, own ? entry.sender : undefined].map(key).filter(Boolean);
    const names = [entry.candidate, own ? entry.from : undefined].map(key).filter(Boolean);
    return [...byKey.values()].find((applicant) => addresses.includes(key(applicant.email)) || names.includes(key(applicant.name)));
  };
  for (const entry of [...seen].sort((a, b) => a.date.localeCompare(b.date))) {
    if (entry.kind !== "application" || !entry.candidate) continue;
    const known = find(entry);
    if (known) {
      // The same student applying twice is one applicant.
      known.emails.push(entry.id);
      known.fit = Math.max(known.fit, entry.fit ?? 0);
      known.availability.push(...(entry.availability ?? []));
      continue;
    }
    byKey.set(key(entry.email || entry.sender) || key(entry.candidate), {
      name: entry.candidate, email: entry.email ?? entry.sender ?? "", school: entry.school ?? "", year: entry.year ?? "", skills: entry.skills ?? [], fit: entry.fit ?? 0, why: entry.why ?? "",
      applied: entry.date, emails: [entry.id], availability: [...(entry.availability ?? [])], referredBy: [], withdrew: false, late: entry.date > role.deadline,
    });
  }
  for (const entry of seen) {
    const applicant = find(entry);
    if (!applicant) continue;
    if (entry.kind === "availability") applicant.availability.push(...(entry.availability ?? []));
    if (entry.kind === "withdrawal") applicant.withdrew = true;
    if (entry.kind === "referral") applicant.referredBy.push(entry.from);
  }
  const applicants = [...byKey.values()].sort((a, b) => b.fit - a.fit || b.referredBy.length - a.referredBy.length || a.name.localeCompare(b.name));
  const booked: Array<{ who: string; day: string; start: number; end: number }> = [];
  const picks = applicants.filter((applicant) => !applicant.withdrew && !applicant.late).slice(0, SHORTLIST).map((applicant) => ({ applicant, slot: book(applicant.availability, booked, role, busy) }));
  return { applicants, picks };
}

// The first half hour inside the student's times when the manager and an engineer are both free,
// with 15 minutes between interviews. The engineer with fewer interviews so far goes first.
function book(windows: Window[], booked: Array<{ who: string; day: string; start: number; end: number }>, role: Role, calendar: Busy[]): Booking | null {
  const manager = role.manager.name;
  const engineers = role.panel.filter((name) => name !== manager);
  const busy = (who: string, day: string) => [
    ...calendar.filter((block) => block.who === who && block.day === day).map((block) => ({ start: hm(block.start), end: hm(block.end) })),
    ...booked.filter((block) => block.who === who && block.day === day).map((block) => ({ start: block.start - 15, end: block.end + 15 })),
  ];
  const free = (who: string, day: string, start: number) => busy(who, day).every((block) => start + INTERVIEW_MIN <= block.start || start >= block.end);
  for (const window of [...windows].sort((a, b) => a.day.localeCompare(b.day) || a.start.localeCompare(b.start))) {
    for (let start = Math.ceil(Math.max(hm(window.start), 9 * 60) / 30) * 30; start + INTERVIEW_MIN <= Math.min(hm(window.end), 17 * 60); start += 30) {
      if (!free(manager, window.day, start)) continue;
      const engineer = [...engineers].sort((a, b) => booked.filter((block) => block.who === a).length - booked.filter((block) => block.who === b).length).find((name) => free(name, window.day, start));
      if (!engineer) continue;
      const slot = { day: window.day, start, end: start + INTERVIEW_MIN, with: engineer };
      booked.push({ who: manager, ...slot }, { who: engineer, ...slot });
      return slot;
    }
  }
  return null;
}

// ---- Writing the invites: one per board, streamed so the page shows it being written.

async function draft({ pick, prompt, role }: { pick: Pick; prompt: string; role: Role }, { report }: SkillContext) {
  const { applicant, slot } = pick;
  const manager = role.manager;
  const subject = slot ? `Interview for the ${role.company} Platform internship: ${when(slot)}` : `${role.company} Platform internship: times for a first interview`;
  const ask = slot
    ? `Invite them to a ${INTERVIEW_MIN}-minute first-round video interview on ${when(slot)} with ${manager.name} and ${slot.with}. Ask them to confirm.`
    : `They have not given times that work. Ask for two or three 45-minute windows between ${dayName(role.week[0])} and ${dayName(role.week.at(-1)!)}, 9am to 5pm Central.`;
  report(0);
  const body = await complete([
    { role: "system", content: `You write emails as ${manager.name}, ${manager.title} at ${role.company}. Warm, short, specific, plain text, no subject line, sign off as ${first(manager.name)}. Under 140 words.` },
    { role: "user", content: `Context: ${prompt}\nTo: ${applicant.name}, ${applicant.year} at ${applicant.school}. What stood out: ${applicant.why}. Skills: ${applicant.skills.join(", ")}.${applicant.referredBy.length ? ` Referred by ${applicant.referredBy.join(" and ")}.` : ""}\n${ask}` },
  ], 600, (text) => report(Math.min(text.length / 750, 0.95), { pages: [text.split("\n").filter(Boolean).slice(-4)] }));
  const lines = body.split("\n").filter(Boolean);
  return { found: { pages: [lines.slice(0, 4)] }, summary: `Invite to ${applicant.name}${slot ? ` for ${when(slot)}` : " asking for times"}`, short: slot ? "Invite ✓" : "Asks for times", data: { name: applicant.name, to: applicant.email, subject, body: body.trim(), slot } as unknown as Json };
}

// ---- The report.

function writeReport({ seen, applicants, drafts, picks, role }: { seen: Seen[]; applicants: Applicant[]; drafts: Draft[]; picks: Pick[]; role: Role }) {
  const booked = picks.filter((pick) => pick.slot);
  const unread = seen.filter((entry) => entry.kind === "unread");
  const undrafted = picks.filter((pick) => !drafts.some((entry) => entry.name === pick.applicant.name));
  const attention = [
    ...(unread.length ? [`${plural(unread.length, "email")} could not be read (${unread.map((entry) => `${entry.id} from ${entry.from}`).join(", ")}), so this list may be missing someone or a withdrawal.`] : []),
    ...undrafted.map((pick) => `The invite to ${pick.applicant.name}${pick.slot ? ` for ${when(pick.slot)}` : ""} could not be written; send it yourself.`),
    ...applicants.filter((applicant) => applicant.withdrew).map((applicant) => `${applicant.name} withdrew, so they are not on the list.`),
    ...applicants.filter((applicant) => applicant.late && !applicant.withdrew).map((applicant) => `${applicant.name} applied after the deadline (fit ${applicant.fit}). Your call whether to add them.`),
    ...applicants.filter((applicant) => applicant.emails.length > 1).map((applicant) => `${applicant.name} applied ${applicant.emails.length} times; counted once.`),
    ...applicants.filter((applicant) => applicant.referredBy.length).map((applicant) => `${applicant.name} was referred by ${applicant.referredBy.join(" and ")} (fit ${applicant.fit}).`),
    ...picks.filter((pick) => !pick.slot).map((pick) => `${pick.applicant.name} has no times that fit the panel yet; the draft asks for some.`),
    ...seen.filter((entry) => entry.kind === "suspicious").map((entry) => `Email ${entry.id} from ${entry.from} looks like phishing: ${entry.why ?? "do not click its links"}.`),
  ];
  const result: Result = {
    headline: `Read ${unread.length ? `${seen.length - unread.length} of ${seen.length}` : plural(seen.length, "email")}, found ${plural(applicants.length, "applicant")} and booked ${plural(booked.length, "interview")}${picks.length > booked.length ? `; ${picks.length - booked.length} still ${picks.length - booked.length === 1 ? "needs" : "need"} times` : ""}.`,
    stats: [
      { value: String(seen.length - unread.length), label: "emails read" },
      { value: String(applicants.length), label: "applicants found" },
      { value: String(booked.length), label: "interviews booked" },
    ],
    sections: [
      { title: "Interviews", kind: "table", columns: ["Student", "School", "Fit", "When", "With", "Why"], rows: picks.map(({ applicant, slot }) => [applicant.name, applicant.school, String(applicant.fit), slot ? when(slot) : "Asked for times", slot ? `${first(role.manager.name)} + ${first(slot.with)}` : "—", applicant.why]) },
      { title: "Needs your attention", kind: "list", items: attention.length ? attention : ["Nothing."] },
      { title: "Draft invites", kind: "cards", cards: drafts.map((entry) => ({ title: entry.subject, subtitle: `To ${entry.name} <${entry.to}>`, lines: entry.body.split("\n").filter(Boolean) })) },
      { title: "Every applicant", kind: "table", columns: ["Student", "School", "Year", "Fit", "Status"], rows: applicants.map((applicant) => [applicant.name, applicant.school, applicant.year, String(applicant.fit), applicant.withdrew ? "Withdrew" : applicant.late ? "Late" : picks.some((pick) => pick.applicant.name === applicant.name) ? "Interview" : "Not this round"]) },
    ],
  };
  return { found: { pages: [[`${booked.length} booked`, `${attention.length} for you to check`]] }, summary: `Booked ${plural(booked.length, "interview")}`, short: "Report ✓", data: result as unknown as Json };
}

// What the orchestrator gets from the inbox and the hiring req before anyone reads: who is hiring for what, and the list of emails.
type Opened = { role: Role; messages: Head[] };
type Done = Parameters<Scenario["stages"][number]["plan"]>[0];
const opened = (done: Done) => {
  const result = outputsOf<Opened | null>(done, "open")[0];
  if (!result) throw new Error("the inbox could not be opened");
  return result;
};
// Every email the boards read. A read step that failed outright (its output has no data) adds nothing.
const seenIn = (done: Done) => outputsOf<Seen[] | null>(done, "read").flatMap((share) => share ?? []);

export const interviews: Scenario = {
  id: "interviews",
  audience: "Hiring manager",
  icon: "resume",
  title: "Find applicants in my inbox, book interviews",
  prompt: `Go through my inbox, find the students who applied for the Platform internship, pick the best ${SHORTLIST}, and book first-round interviews next week around my panel's calendar. Draft the invites.`,
  data: {
    label: "Live AI on a demo inbox of about 80 emails and the panel's calendar",
    items: ["The mail, calendar and hiring req are made up, and served by the gateway for the boards to query", "Applications with resumes, replies, withdrawals, referrals, a phishing email and everyday noise"],
  },
  sample: true,
  stages: [
    {
      label: "Open the inbox",
      short: "Open",
      icon: "mail",
      plan: () => [{ skill: "open", instruction: "Open the inbox and the hiring req, and split the emails between the boards", label: "Open the inbox", icon: "mail", params: null, ms: 1500, role: "orchestrator" }],
    },
    {
      label: "Read every email",
      short: "Read",
      icon: "mail",
      plan: (done) => {
        const { role, messages } = opened(done);
        return groups(messages, SHARES).map((share, index) => ({
          skill: "read",
          instruction: `Fetch and read ${plural(share.length, "email")} (part ${index + 1} of ${SHARES}), resumes included, and pull out every applicant`,
          label: `Inbox part ${index + 1}`,
          icon: "mail" as const,
          preview: listPreview("inbox", share.map((head): [string, string] => [head.from.name, head.subject])),
          params: { ids: share.map((head) => head.id), role } as unknown as Json,
          ms: 30000,
          meter: { verb: "Read", noun: "emails", total: share.length },
        }));
      },
    },
    {
      label: "Rank and book the panel",
      short: "Book",
      icon: "calendar",
      plan: (done) => [{ skill: "book", instruction: `Merge every applicant the boards found, rank them, and book the top ${SHORTLIST} around the panel's calendar`, label: "Rank and book", icon: "calendar", params: { seen: seenIn(done), role: opened(done).role } as unknown as Json, ms: 2500, role: "orchestrator" }],
    },
    {
      label: "Write the invites",
      short: "Invites",
      icon: "reply",
      plan: (done, prompt) => (outputsOf<{ picks: Pick[] } | null>(done, "book")[0]?.picks ?? []).map((pick) => ({
        skill: "draft",
        instruction: pick.slot ? `Write ${pick.applicant.name} an invite for ${when(pick.slot)}` : `Write ${pick.applicant.name} asking for interview times`,
        label: `Invite ${first(pick.applicant.name)}`,
        icon: "reply" as const,
        preview: pagePreview("draft", [{ url: `To ${pick.applicant.name}`, lines: [pick.applicant.school, `Fit ${pick.applicant.fit}: ${pick.applicant.why}`, pick.slot ? when(pick.slot) : "No time yet"] }]),
        params: { pick, prompt, role: opened(done).role } as unknown as Json,
        ms: 12000,
      })),
    },
    {
      label: "Report back",
      short: "Report",
      icon: "doc",
      plan: (done) => [{ skill: "report", instruction: "Put the schedule, the drafts and what needs a decision in one report", label: "Write report", icon: "doc", params: { seen: seenIn(done), applicants: outputsOf<{ applicants: Applicant[] } | null>(done, "book")[0]?.applicants ?? [], picks: outputsOf<{ picks: Pick[] } | null>(done, "book")[0]?.picks ?? [], drafts: outputsOf<Draft | null>(done, "draft").filter(Boolean), role: opened(done).role } as unknown as Json, ms: 2000, role: "orchestrator" }],
    },
  ],
  skills: {
    open: async () => {
      const [role, inbox] = await Promise.all([query<Role>("/hiring/role"), query<{ messages: Head[] }>("/mail/inbox")]);
      const resumes = inbox.messages.filter((head) => head.attachments.length).length;
      return { summary: `${plural(inbox.messages.length, "email")} in the inbox, ${resumes} with attachments`, short: plural(inbox.messages.length, "email"), data: { role, messages: inbox.messages } as unknown as Json };
    },
    read,
    book: async ({ seen, role }: { seen: Seen[]; role: Role }) => {
      const { events } = await query<{ events: Busy[] }>("/calendar/events");
      const { applicants, picks } = shortlist(seen, role, events);
      const booked = picks.filter((pick) => pick.slot).length;
      return { summary: `${plural(applicants.length, "applicant")}; booked ${booked} of ${picks.length}`, short: `${booked} booked`, data: { applicants, picks } as unknown as Json };
    },
    draft,
    report: writeReport,
  },
};
