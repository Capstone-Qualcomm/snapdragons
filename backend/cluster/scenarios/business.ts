import { groups, listing, listPreview, outputsOf, pagePreview, plural } from "../plan.ts";
import type { Result, Scenario } from "../plan.ts";

// A small catering bakery's books and customer inbox. The bakery, customers
// and amounts are made up. "Today" for this data is Fri Oct 23, 2026.

type Invoice = { number: string; customer: string; amount: number; due: string };
type Payment = { invoice: string; amount: number; date: string };
type Message = { id: number; from: string; text: string; kind: "email" | "review" };
type Unpaid = Invoice & { owed: number; daysOverdue: number };
type Complaint = { id: number; from: string; theme: string; text: string };

const TODAY = "2026-10-23";
const days = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

const CUSTOMERS: Record<string, string> = {
  "Maple Street Dental": "office@maplestreetdental.example",
  "Riverside Book Club": "hello@riversidebooks.example",
  "Kestrel Architects": "admin@kestrel.example",
  "Hilltop Elementary PTA": "pta@hilltop.example",
  "Orchard Yoga": "studio@orchardyoga.example",
  "Bluebird Law": "accounts@bluebirdlaw.example",
  "Copper Pot Cafe": "owner@copperpot.example",
  "Northside Rotary": "treasurer@northsiderotary.example",
};
const NAMES = Object.keys(CUSTOMERS);

export const INVOICES: Invoice[] = Array.from({ length: 30 }, (_, index) => ({
  number: `INV-${1040 + index}`,
  customer: NAMES[(index * 3) % NAMES.length],
  amount: 120 + ((index * 53) % 9) * 45,
  due: `2026-${index < 18 ? "09" : "10"}-${String(5 + (index * 7) % 23).padStart(2, "0")}`,
}));

// Payments that came in. Five invoices have none, and one was only partly paid.
const UNPAID = new Set(["INV-1043", "INV-1049", "INV-1055", "INV-1061", "INV-1064"]);
export const PAYMENTS: Payment[] = INVOICES.filter((invoice) => !UNPAID.has(invoice.number) && invoice.due < TODAY).map((invoice) => ({
  invoice: invoice.number,
  amount: invoice.number === "INV-1051" ? invoice.amount - 100 : invoice.amount,
  date: invoice.due,
}));

const THEMES: Array<[string, RegExp]> = [
  ["Late delivery", /late|waited|arrived after/i],
  ["Wrong order", /wrong|missing|instead of/i],
  ["Price increase", /price|expensive|charged more/i],
];

const COMPLAINTS: Record<number, [string, string]> = {
  4: ["Kestrel Architects", "Our lunch order arrived after the meeting had started. Second time this month."],
  9: ["Google review, 2 stars", "Waited 40 minutes past the pickup time for a birthday cake."],
  13: ["Orchard Yoga", "We ordered gluten-free muffins and got the regular ones instead of what we asked for."],
  17: ["Yelp review, 3 stars", "Love the croissants, but the price went up again and it is getting expensive."],
  22: ["Maple Street Dental", "The platter was missing the fruit tray we paid for."],
  26: ["Bluebird Law", "Delivery was late again on Tuesday; the client meeting started without food."],
  31: ["Google review, 2 stars", "Charged more than the menu price for a dozen cookies."],
  37: ["Riverside Book Club", "Order showed up late and the coffee was cold."],
};

const PRAISE = ["Best sourdough in town!", "Thanks for the lovely cake.", "Can I get the fall menu?", "Do you cater weddings in June?", "The scones were a hit at our meeting."];

export const INBOX: Message[] = Array.from({ length: 40 }, (_, index) => {
  const id = index + 1;
  if (COMPLAINTS[id]) return { id, from: COMPLAINTS[id][0], text: COMPLAINTS[id][1], kind: COMPLAINTS[id][0].includes("review") ? "review" : "email" };
  return { id, from: index % 3 ? NAMES[index % NAMES.length] : "Google review, 5 stars", text: PRAISE[index % PRAISE.length], kind: index % 3 ? "email" : "review" };
});

const money = (amount: number) => `$${amount.toLocaleString("en-US")}`;

export const business: Scenario = {
  id: "business",
  audience: "Small business",
  icon: "invoice",
  title: "Chase unpaid invoices, answer complaints",
  prompt: "Find who still owes me money, check what customers are unhappy about this week, and draft what I should send.",
  data: {
    label: "Running on a demo bakery's invoices, bank deposits and customer inbox",
    items: ["Demo invoices: 30 catering invoices from Sep–Oct", `Demo bank deposits: ${PAYMENTS.length} payments`, "Demo customer inbox: 40 emails and reviews"],
  },
  stages: [
    {
      label: "Check invoices + read customer messages",
      short: "Books + inbox",
      icon: "invoice",
      plan: () => [
        ...groups(INVOICES.map((invoice) => invoice.number), 2).map((numbers, index) => ({ skill: "ledger", instruction: `Check invoices ${index ? "16–30" : "1–15"} against bank deposits and list what is unpaid`, label: `Invoices ${index ? "16–30" : "1–15"}`, icon: "invoice" as const, preview: listPreview("invoice", numbers.map((number): [string, string] => {
          const invoice = INVOICES.find((entry) => entry.number === number)!;
          return [invoice.number, `${invoice.customer} · ${money(invoice.amount)}`];
        })), params: { numbers }, ms: 6000, meter: { verb: "Checked", noun: "invoices", total: numbers.length } })),
        ...[[1, 20], [21, 40]].map(([from, to]) => ({ skill: "messages", instruction: `Read customer messages ${from}–${to} and pick out complaints`, label: `Messages ${from}–${to}`, icon: "chat" as const, preview: listPreview("chat", INBOX.slice(from - 1, to).map((message): [string, string] => [message.from, message.text])), params: { from, to }, ms: 5500, meter: { verb: "Read", noun: "messages", total: to - from + 1 } })),
      ],
    },
    {
      label: "Match unpaid invoices to customers",
      short: "Match",
      icon: "merge",
      plan: (done) => [{ skill: "match", instruction: "Group unpaid invoices by customer and complaints by theme", label: "Match + group", icon: "merge", params: { unpaid: outputsOf<Unpaid[]>(done, "ledger").flat(), complaints: outputsOf<Complaint[]>(done, "messages").flat() }, ms: 2500, role: "orchestrator" }],
    },
    {
      label: "Draft reminders + replies",
      short: "Drafts",
      icon: "reply",
      plan: (done) => {
        const { owing, themes } = outputsOf<{ owing: Array<{ customer: string; invoices: Unpaid[] }>; themes: Array<{ theme: string; complaints: Complaint[] }> }>(done, "match")[0];
        return [
          ...groups(owing, 2).map((group) => ({ skill: "reminder", instruction: `Draft payment reminders to ${listing(group.map((entry) => entry.customer))}`, label: `${plural(group.length, "reminder")}`, icon: "mail" as const, preview: pagePreview("doc", group.map((entry) => ({ url: `To ${entry.customer}`, lines: entry.invoices.map((invoice) => `${invoice.number} · ${money(invoice.owed)} · ${invoice.daysOverdue} days late`) }))), params: { owing: group }, ms: 4500, meter: { verb: "Drafted", noun: "reminders", total: group.length }, assign: "previous" as const })),
          ...themes.map((theme) => ({ skill: "apology", instruction: `Draft replies to the ${plural(theme.complaints.length, "complaint")} about ${theme.theme.toLowerCase()}`, label: `${theme.theme} replies`, icon: "reply" as const, preview: pagePreview("doc", theme.complaints.map((complaint) => ({ url: `To ${complaint.from}`, lines: [complaint.text] }))), params: theme, ms: 4500, meter: { verb: "Drafted", noun: "replies", total: theme.complaints.length }, assign: "fresh" as const })),
        ];
      },
    },
    {
      label: "Put it together",
      short: "Report",
      icon: "doc",
      plan: (done) => [{ skill: "final", instruction: "Write the overdue list, the complaint themes and every draft in one place", label: "Overdue + drafts", icon: "doc", params: { match: outputsOf(done, "match")[0], reminders: outputsOf(done, "reminder").flat(), apologies: outputsOf(done, "apology").flat() }, ms: 3000, role: "orchestrator" }],
    },
  ],
  skills: {
    ledger: ({ numbers }: { numbers: string[] }) => {
      const unpaid: Unpaid[] = INVOICES.filter((invoice) => numbers.includes(invoice.number) && invoice.due < TODAY).flatMap((invoice) => {
        const paid = PAYMENTS.filter((payment) => payment.invoice === invoice.number).reduce((sum, payment) => sum + payment.amount, 0);
        return paid >= invoice.amount ? [] : [{ ...invoice, owed: invoice.amount - paid, daysOverdue: days(invoice.due, TODAY) }];
      });
      const marks = numbers.flatMap((number, row): Array<[number, string]> => {
        const invoice = unpaid.find((entry) => entry.number === number);
        return invoice ? [[row, `unpaid ${money(invoice.owed)}`]] : [];
      });
      return { found: { marks }, summary: `${plural(unpaid.length, "invoice")} unpaid, ${money(unpaid.reduce((sum, invoice) => sum + invoice.owed, 0))} owed`, short: `${unpaid.length} unpaid`, data: unpaid };
    },
    messages: ({ from, to }: { from: number; to: number }) => {
      const complaints: Complaint[] = INBOX.slice(from - 1, to).flatMap((message) => {
        const theme = THEMES.find(([, pattern]) => pattern.test(message.text));
        return theme ? [{ id: message.id, from: message.from, theme: theme[0], text: message.text }] : [];
      });
      const marks = complaints.map((complaint): [number, string] => [complaint.id - from, complaint.theme.toLowerCase()]);
      return { found: { marks }, summary: `${plural(complaints.length, "complaint")}: ${listing([...new Set(complaints.map((complaint) => complaint.theme.toLowerCase()))])}`, short: plural(complaints.length, "complaint"), data: complaints };
    },
    match: ({ unpaid, complaints }: { unpaid: Unpaid[]; complaints: Complaint[] }) => {
      const owing = [...new Set(unpaid.map((invoice) => invoice.customer))].map((customer) => ({ customer, email: CUSTOMERS[customer], invoices: unpaid.filter((invoice) => invoice.customer === customer) }));
      const themes = THEMES.map(([theme]) => ({ theme, complaints: complaints.filter((complaint) => complaint.theme === theme) })).filter((entry) => entry.complaints.length);
      return { summary: `${plural(owing.length, "customer")} owe money; ${plural(themes.length, "complaint theme")}`, short: `${owing.length} owe money`, data: { owing, themes } };
    },
    reminder: ({ owing }: { owing: Array<{ customer: string; email: string; invoices: Unpaid[] }> }) => {
      const data = owing.map((entry) => {
        const total = entry.invoices.reduce((sum, invoice) => sum + invoice.owed, 0);
        const list = entry.invoices.map((invoice) => `${invoice.number} (${money(invoice.owed)}, due ${invoice.due})`).join(", ");
        return { to: entry.customer, draft: `Hi ${entry.customer}, a friendly reminder that ${list} ${entry.invoices.length > 1 ? "are" : "is"} still open, ${money(total)} in total. You can pay by card at the link on the invoice or by bank transfer. Thank you for ordering with Juniper Street Bakery!` };
      });
      return { found: { pages: data.map((entry) => [entry.draft.split(". ")[0] + "."]) }, summary: `Drafted reminders to ${listing(data.map((entry) => entry.to))}`, short: plural(data.length, "reminder"), data };
    },
    apology: ({ theme, complaints }: { theme: string; complaints: Complaint[] }) => {
      const fix: Record<string, string> = { "Late delivery": "We have added a second driver for lunch orders so this doesn't happen again", "Wrong order": "We now check every order against the ticket before it leaves", "Price increase": "Butter and flour went up this fall; the old prices stay for orders placed this month" };
      const data = complaints.map((complaint) => ({ to: complaint.from, theme, draft: `Thank you for telling us, and we're sorry. ${fix[theme]}. ${complaint.from.includes("review") ? "Please stop by and your next coffee is on us." : "Your next order has 15% off."}` }));
      return { found: { pages: data.map((entry) => [entry.draft.split(". ").slice(0, 2).join(". ") + "."]) }, summary: `Drafted ${plural(data.length, "reply", "replies")} about ${theme.toLowerCase()}`, short: plural(data.length, "draft"), data };
    },
    final: ({ match, reminders, apologies }: any) => {
      const unpaid: Unpaid[] = match.owing.flatMap((entry: { invoices: Unpaid[] }) => entry.invoices).sort((a: Unpaid, b: Unpaid) => b.daysOverdue - a.daysOverdue);
      const total = unpaid.reduce((sum, invoice) => sum + invoice.owed, 0);
      const top = match.themes.sort((a: { complaints: unknown[] }, b: { complaints: unknown[] }) => b.complaints.length - a.complaints.length)[0];
      const result: Result = {
        headline: `${plural(match.owing.length, "customer")} owe you ${money(total)}. The most common complaint this week is ${top.theme.toLowerCase()} (${top.complaints.length}).`,
        stats: [
          { value: money(total), label: "overdue" },
          { value: String(match.owing.length), label: "customers owe" },
          { value: String(match.themes.reduce((sum: number, entry: { complaints: unknown[] }) => sum + entry.complaints.length, 0)), label: "complaints" },
        ],
        sections: [
          { title: "Overdue invoices", kind: "table", columns: ["Customer", "Invoice", "Amount due", "Days overdue"], rows: unpaid.map((invoice) => [invoice.customer, invoice.number, money(invoice.owed), String(invoice.daysOverdue)]) },
          { title: "What customers are unhappy about", kind: "table", columns: ["Theme", "Messages", "Example"], rows: match.themes.map((entry: { theme: string; complaints: Complaint[] }) => [entry.theme, String(entry.complaints.length), `"${entry.complaints[0].text}"`]) },
          { title: "Drafts to send", kind: "cards", cards: [...reminders.map((entry: { to: string; draft: string }) => ({ title: entry.to, subtitle: "Payment reminder", lines: [entry.draft] })), ...apologies.map((entry: { to: string; theme: string; draft: string }) => ({ title: entry.to, subtitle: `Reply about ${entry.theme.toLowerCase()}`, lines: [entry.draft] }))] },
        ],
      };
      return { summary: `${money(total)} overdue, ${plural(reminders.length + apologies.length, "draft")} ready`, short: "Report ✓", data: result };
    },
  },
};
