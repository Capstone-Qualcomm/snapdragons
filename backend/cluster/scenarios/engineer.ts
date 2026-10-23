import { groups, listing, listPreview, outputsOf, pagePreview, plural } from "../plan.ts";
import type { Result, Scenario } from "../plan.ts";

// A software engineer's morning, on demo Slack, Jira and GitHub data shaped
// like what the Today page loads. The team, people and repos are made up.

type Message = { id: number; channel: string; from: string; text: string; at: string };
type Ticket = { key: string; summary: string; status: string; assignee: string; due: string | null; blockedBy: string | null };
type Pr = { number: number; title: string; author: string; reviewers: string[]; ci: "passing" | "failing"; run: number | null; ageHours: number };

const ME = "you";

const SLACK: Message[] = [
  { id: 1, channel: "DM", from: "Priya Raman", text: "Morning! Can you review my PR #212 before noon? It's blocking the release.", at: "08:12" },
  { id: 2, channel: "#incidents", from: "Ops Bot", text: "@you checkout-service p95 latency is 2.4 s since last night's deploy.", at: "07:40" },
  { id: 3, channel: "DM", from: "Jordan Lee", text: "Are we still on for the 1:1 at 2? I'd like your input on the Q4 roadmap doc.", at: "08:30" },
  { id: 4, channel: "#dev", from: "Alex Kim", text: "@you can you confirm the ledger migration runs before Friday's freeze?", at: "09:02" },
  { id: 5, channel: "#random", from: "Sam Diaz", text: "Bagels in the kitchen!", at: "08:05" },
  { id: 6, channel: "#dev", from: "Riley Chen", text: "Merged the lint config update, rebase when you can.", at: "Yesterday 17:20" },
  { id: 7, channel: "#releases", from: "Release Bot", text: "Release 4.18 is scheduled for Thursday.", at: "Yesterday 16:00" },
  { id: 8, channel: "#random", from: "Morgan Fox", text: "Anyone up for trivia Thursday?", at: "Yesterday 15:45" },
  { id: 9, channel: "#dev", from: "Alex Kim", text: "Standup moved to 10:15 today.", at: "08:50" },
  { id: 10, channel: "#incidents", from: "Taylor Brooks", text: "Rolled back the cache change, still seeing slow checkouts.", at: "08:20" },
  ...Array.from({ length: 26 }, (_, index) => ({ id: 11 + index, channel: ["#random", "#dev", "#design", "#releases"][index % 4], from: ["Sam Diaz", "Riley Chen", "Morgan Fox", "Casey Wu"][index % 4], text: ["Nice work on the demo yesterday.", "Docs are updated for the new endpoint.", "New icons are in Figma.", "Changelog draft is up for review."][index % 4], at: "Yesterday" })),
];

const JIRA: Ticket[] = [
  { key: "PAY-305", summary: "Checkout times out on slow networks", status: "Blocked", assignee: ME, due: "Today", blockedBy: "CI failing on PR #208" },
  { key: "PAY-298", summary: "Migrate ledger to the v2 schema", status: "To Do", assignee: ME, due: "Tomorrow", blockedBy: null },
  { key: "PAY-311", summary: "Fix flaky retry test", status: "In Progress", assignee: ME, due: null, blockedBy: null },
  { key: "PAY-290", summary: "Write runbook for refunds", status: "To Do", assignee: ME, due: "Next week", blockedBy: null },
  { key: "PAY-301", summary: "Add metrics to the payout job", status: "In Review", assignee: "Riley Chen", due: null, blockedBy: null },
  { key: "PAY-307", summary: "Upgrade the Postgres driver", status: "To Do", assignee: "Alex Kim", due: null, blockedBy: null },
  { key: "PAY-299", summary: "Dashboard for failed payments", status: "Done", assignee: ME, due: null, blockedBy: null },
  { key: "PAY-312", summary: "Refund emails show the wrong currency", status: "To Do", assignee: "Casey Wu", due: null, blockedBy: null },
];

const PRS: Pr[] = [
  { number: 212, title: "Retry card authorizations with backoff", author: "Priya Raman", reviewers: [ME], ci: "passing", run: 5520, ageHours: 16 },
  { number: 208, title: "Shorter checkout timeouts on slow networks", author: ME, reviewers: ["Alex Kim"], ci: "failing", run: 5512, ageHours: 20 },
  { number: 214, title: "Add idempotency keys to payouts", author: "Riley Chen", reviewers: [ME, "Alex Kim"], ci: "passing", run: 5523, ageHours: 3 },
  { number: 215, title: "Bump lodash from 4.17.20 to 4.17.21", author: "dependabot", reviewers: [], ci: "passing", run: 5525, ageHours: 2 },
  { number: 199, title: "Ledger v2 read path", author: ME, reviewers: ["Priya Raman"], ci: "passing", run: 5490, ageHours: 70 },
];

const CI_LOGS: Record<number, string> = {
  5512: [
    "> npm run test:integration",
    "starting ledger-db container",
    "waiting for ledger-db:5432 ...",
    "Error: connect ECONNREFUSED 127.0.0.1:5432",
    "TimeoutError: ledger-db did not become ready in 30s",
    "FAIL checkout/timeout.test.ts (31.2 s)",
    "Tests: 1 failed, 214 passed",
  ].join("\n"),
};

const DIFFS: Record<number, { files: string[]; added: number; removed: number; note: string }> = {
  212: { files: ["payments/authorize.go", "payments/retry.go", "payments/retry_test.go"], added: 148, removed: 22, note: "Wraps card authorization in a retry with exponential backoff (3 tries, 200 ms base). Retries also on 409, which could double-charge if the processor already accepted the first try." },
  214: { files: ["payouts/job.go", "payouts/store.go"], added: 61, removed: 9, note: "Adds an idempotency key column and checks it before sending a payout. Small and well tested." },
};

const mine = (text: string) => /@you/.test(text);

export const engineer: Scenario = {
  id: "engineer",
  audience: "Engineer",
  icon: "github",
  title: "Catch up on Slack, Jira and GitHub",
  prompt: "Catch me up on everything since yesterday and tell me what to do first.",
  data: {
    label: "Running on demo Slack, Jira and GitHub data",
    items: ["Demo Slack: 36 messages in 5 channels and DMs", "Demo Jira: 8 tickets on a made-up payments team", "Demo GitHub: 5 pull requests and their CI runs"],
  },
  stages: [
    {
      label: "Read Slack, Jira and GitHub",
      short: "Read all",
      icon: "slack",
      plan: () => [
        { skill: "slack", instruction: "Read Slack since yesterday: find DMs and mentions that need you", label: "Slack since yesterday", icon: "slack", preview: listPreview("chat", SLACK.map((message): [string, string] => [`${message.channel === "DM" ? "DM" : message.channel} · ${message.from}`, message.text])), params: null, ms: 6000, meter: { verb: "Read", noun: "messages", total: SLACK.length } },
        { skill: "jira", instruction: "Go through your Jira tickets: what is due, started or blocked", label: "Your Jira tickets", icon: "jira", preview: listPreview("items", JIRA.map((ticket): [string, string] => [ticket.key, `${ticket.summary} · ${ticket.status}`])), params: null, ms: 5000, meter: { verb: "Checked", noun: "tickets", total: JIRA.length } },
        { skill: "github", instruction: "Check GitHub: PRs waiting on your review and your PRs with failing CI", label: "PRs + CI", icon: "github", preview: listPreview("items", PRS.map((pr): [string, string] => [`#${pr.number} · ${pr.author}`, `${pr.title} · CI ${pr.ci}`])), params: null, ms: 5500, meter: { verb: "Checked", noun: "pull requests", total: PRS.length } },
      ],
    },
    {
      label: "Dig into blockers + draft replies",
      short: "Dig + draft",
      icon: "search",
      plan: (done) => {
        const github = outputsOf<{ toReview: Pr[]; failing: Pr[] }>(done, "github")[0];
        const slack = outputsOf<{ needYou: Message[] }>(done, "slack")[0];
        return [
          ...github.failing.map((pr) => ({ skill: "ciLog", instruction: `Read the failing CI log for your PR #${pr.number} and find the cause`, label: `CI log #${pr.number}`, icon: "log" as const, preview: pagePreview("log", [{ url: `ci/run/${pr.run}`, lines: (CI_LOGS[pr.run!] ?? "").split("\n") }]), params: { run: pr.run, pr: pr.number }, ms: 5000, meter: { verb: "Read", noun: "log lines", total: CI_LOGS[pr.run!]?.split("\n").length ?? 1 }, assign: "fresh" as const })),
          ...github.toReview.map((pr) => ({ skill: "diff", instruction: `Read the diff of PR #${pr.number} by ${pr.author} and note the risks`, label: `PR #${pr.number} diff`, icon: "diff" as const, preview: pagePreview("doc", [{ url: `github.example/pull/${pr.number}`, lines: [...(DIFFS[pr.number]?.files ?? []), `+${DIFFS[pr.number]?.added} −${DIFFS[pr.number]?.removed}`] }]), params: { pr: pr.number, author: pr.author, title: pr.title }, ms: 5000, meter: { verb: "Read", noun: "files", total: DIFFS[pr.number]?.files.length ?? 1 }, assign: "fresh" as const })),
          // People get a drafted reply; an alert from a bot gets looked into instead.
          ...groups(slack.needYou.filter((message) => !/Bot$/.test(message.from)), 2).map((messages) => ({ skill: "draft", instruction: `Draft replies to ${listing(messages.map((message) => message.from))}`, label: `Reply ${messages.map((message) => message.from.split(" ")[0]).join(" + ")}`, icon: "reply" as const, preview: pagePreview("doc", messages.map((message) => ({ url: `Reply to ${message.from}`, lines: [message.text] }))), params: { messages }, ms: 4500, meter: { verb: "Drafted", noun: "replies", total: messages.length }, assign: "previous" as const })),
        ];
      },
    },
    {
      label: "Rank the day and write standup",
      short: "Plan the day",
      icon: "list",
      plan: (done) => [
        {
          skill: "plan",
          instruction: "Rank everything into one to-do list and write your standup update",
          label: "To-do + standup",
          icon: "list",
          params: {
            slack: outputsOf(done, "slack")[0],
            jira: outputsOf(done, "jira")[0],
            github: outputsOf(done, "github")[0],
            causes: outputsOf(done, "ciLog"),
            reviews: outputsOf(done, "diff"),
            drafts: outputsOf(done, "draft").flat(),
          },
          ms: 3500,
          role: "orchestrator",
        },
      ],
    },
  ],
  skills: {
    slack: () => {
      const needYou = SLACK.filter((message) => message.channel === "DM" || mine(message.text));
      const marks = SLACK.flatMap((message, row): Array<[number, string]> => (needYou.includes(message) ? [[row, message.channel === "DM" ? "DM" : "mention"]] : []));
      return { found: { marks }, summary: `${plural(needYou.length, "message")} need you: ${listing(needYou.map((message) => `${message.from} (${message.channel})`))}`, short: `${needYou.length} need you`, data: { read: SLACK.length, needYou } };
    },
    jira: () => {
      const open = JIRA.filter((ticket) => ticket.assignee === ME && ticket.status !== "Done");
      const blocked = open.filter((ticket) => ticket.status === "Blocked");
      const marks = JIRA.flatMap((ticket, row): Array<[number, string]> => (open.includes(ticket) ? [[row, ticket.status === "Blocked" ? "blocked" : ticket.due ? `due ${ticket.due.toLowerCase()}` : "yours"]] : []));
      return { found: { marks }, summary: `${plural(open.length, "open ticket")}; ${listing(blocked.map((ticket) => `${ticket.key} is blocked`))}`, short: `${open.length} open, ${blocked.length} blocked`, data: { open, blocked } };
    },
    github: () => {
      const toReview = PRS.filter((pr) => pr.reviewers.includes(ME));
      const failing = PRS.filter((pr) => pr.author === ME && pr.ci === "failing");
      const marks = PRS.flatMap((pr, row): Array<[number, string]> => (toReview.includes(pr) ? [[row, "review"]] : failing.includes(pr) ? [[row, "CI failing"]] : []));
      return { found: { marks }, summary: `${plural(toReview.length, "PR")} wait on your review (${listing(toReview.map((pr) => `#${pr.number}`))}); your #${failing.map((pr) => pr.number).join(", #")} fails CI`, short: `${toReview.length} reviews, ${failing.length} failing`, data: { toReview, failing } };
    },
    ciLog: ({ run, pr }: { run: number; pr: number }) => {
      const log = CI_LOGS[run] ?? "";
      const error = log.split("\n").find((line) => /TimeoutError|Error:/.test(line)) ?? "No error line found";
      const cause = /did not become ready|ECONNREFUSED/.test(log) ? "The test database container did not start in time, so it is the CI setup, not your change. Re-run with a longer wait, or fix the health check." : "Unknown";
      return { found: { pages: [["Cause: test database did not start", error, "Not your change"]] }, summary: `PR #${pr} fails because the test database did not start in time`, short: "Cause found", data: { pr, run, error, cause } };
    },
    diff: ({ pr, author, title }: { pr: number; author: string; title: string }) => {
      const diff = DIFFS[pr];
      const risky = /double-charge|could/.test(diff.note);
      return { found: { pages: [[`${diff.files.length} files, +${diff.added} −${diff.removed}`, risky ? "Risk: retries on 409" : "Looks safe"]] }, summary: `#${pr}: ${diff.files.length} files, +${diff.added} −${diff.removed}${risky ? ", one risk to flag" : ", looks safe"}`, short: risky ? "1 risk" : "Looks safe", data: { pr, author, title, files: diff.files.length, added: diff.added, removed: diff.removed, note: diff.note, risky } };
    },
    draft: ({ messages }: { messages: Array<{ from: string; channel: string; text: string }> }) => {
      const reply = (message: { from: string; text: string }) =>
        /review my PR #(\d+)/.test(message.text) ? `Hi ${message.from.split(" ")[0]}, on it. I'll have a review on #${message.text.match(/#(\d+)/)![1]} before noon; one question on retrying 409s coming in the PR.`
          : /1:1/.test(message.text) ? `Yes, still on for 2. I'll read the Q4 roadmap doc before then and bring notes.`
            : /latency/.test(message.text) ? `Looking now. The rollback didn't help, so I'll check the deploy diff and the DB connection pool next.`
              : /migration/.test(message.text) ? `Yes, the ledger migration (PAY-298) is planned for tomorrow, ahead of Friday's freeze.`
                : `Thanks, will take a look today.`;
      const data = messages.map((message) => ({ to: message.from, where: message.channel, draft: reply(message) }));
      return { found: { pages: data.map((entry) => [entry.draft]) }, summary: `Drafted ${plural(data.length, "reply", "replies")}: ${listing(data.map((entry) => entry.to))}`, short: plural(data.length, "draft"), data };
    },
    plan: ({ slack, jira, github, causes, reviews, drafts }: any) => {
      // Someone blocked on you first, then what is broken, then what is due, then the rest.
      const todo: Array<[number, string, string, string]> = [];
      for (const review of reviews) todo.push([review.author === "Priya Raman" ? 1 : 4, `Review PR #${review.pr} (${review.title})`, review.risky ? `${review.author} is blocked on it. Flag: ${review.note.split(". ").at(-1)}` : "Small and safe; quick approve", "GitHub"]);
      for (const cause of causes) todo.push([2, `Unblock your PR #${cause.pr}`, cause.cause, "GitHub CI"]);
      for (const message of slack.needYou.filter((entry: Message) => /latency/.test(entry.text))) todo.push([3, "Look into the checkout latency alert", `${message.from} in ${message.channel}: ${message.text.replace("@you ", "")}`, "Slack"]);
      for (const ticket of jira.open as Ticket[]) {
        if (ticket.status === "Blocked") continue;
        todo.push([ticket.due === "Tomorrow" ? 5 : ticket.status === "In Progress" ? 6 : 7, `${ticket.key}: ${ticket.summary}`, ticket.due ? `Due ${ticket.due.toLowerCase()}` : ticket.status, "Jira"]);
      }
      todo.sort((a, b) => a[0] - b[0]);
      const result: Result = {
        headline: `${plural(todo.length, "thing")} to do. Start with Priya's PR #212: she is blocked on you before noon.`,
        stats: [
          { value: String(todo.length), label: "things to do" },
          { value: String(drafts.length), label: "replies drafted" },
          { value: "#212", label: "do first" },
        ],
        sections: [
          { title: "What to do first", kind: "table", columns: ["#", "Do this", "Why", "From"], rows: todo.map(([, what, why, from], index) => [String(index + 1), what, why, from]) },
          { title: "Drafted replies", kind: "cards", cards: drafts.map((draft: { to: string; where: string; draft: string }) => ({ title: draft.to, subtitle: draft.where === "DM" ? "Direct message" : draft.where, lines: [draft.draft] })) },
          {
            title: "Standup update",
            kind: "text",
            body: `Yesterday: opened #208 for checkout timeouts and kept going on the ledger v2 read path (#199). Today: review #212 and #214, get #208 green (CI's test database is timing out, not the change), then start the ledger migration (PAY-298). Blocked: ${jira.blocked.map((ticket: Ticket) => `${ticket.key} waits on CI for #208`).join("; ")}.`,
          },
        ],
      };
      return { summary: `Ranked ${plural(todo.length, "task")}, ${plural(drafts.length, "draft")} and a standup`, short: "Plan ✓", data: result };
    },
  },
};
