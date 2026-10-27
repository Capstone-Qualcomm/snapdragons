import { complete, jsonFrom } from "../llm.ts";
import { outputsOf, pagePreview, plural, sentences } from "../plan.ts";
import type { Result, Scenario } from "../plan.ts";

// Anything a person types, done live by the model: the orchestrator splits the job into
// parts, each board works one part at the same time, and the orchestrator combines them.
// No demo data: every answer comes from DeepSeek-V4.1-Flash as the steps run.

type Part = { label: string; instruction: string };
type Work = { label: string; bullets: string[]; text: string };

const MAX_PARTS = 5;

// The stages read only the steps' outputs, so they stay pure; only the skills call the model.
const partsOf = (prompt: string, plans: Array<{ parts: Part[] }>): Part[] => {
  const parts = plans[0]?.parts?.filter((part) => part.label && part.instruction).slice(0, MAX_PARTS) ?? [];
  return parts.length ? parts : [{ label: "Answer", instruction: prompt }];
};

const words = (text: string, count: number) => text.split(/\s+/).slice(0, count).join(" ");

export const ask: Scenario = {
  id: "ask",
  audience: "Anyone",
  icon: "chat",
  title: "Your own job, live",
  prompt: "Compare the four best laptops for a computer science student under $1,200 and tell me which one to buy.",
  data: {
    label: "Live: DeepSeek-V4.1-Flash on Azure, no demo data",
    items: ["Type any job. The orchestrator splits it into parts with the model,", "each board works one part at the same time, and the orchestrator combines them."],
  },
  stages: [
    {
      label: "Split the job into parts",
      short: "Plan",
      icon: "list",
      plan: (_done, prompt) => [{ skill: "plan", instruction: `Split "${words(prompt, 12)}…" into parts the boards can do at the same time`, label: "Split the job", icon: "list", preview: pagePreview("doc", [{ url: "Your job", lines: sentences(prompt) }]), params: { prompt }, ms: 2500, role: "orchestrator" }],
    },
    {
      label: "Work every part at once",
      short: "Work",
      icon: "doc",
      plan: (done, prompt) =>
        partsOf(prompt, outputsOf(done, "plan")).map((part) => ({ skill: "work", instruction: part.instruction, label: words(part.label, 4), icon: "doc" as const, preview: pagePreview("doc", [{ url: part.label, lines: sentences(part.instruction) }]), params: { prompt, ...part }, ms: 4000 })),
    },
    {
      label: "Combine the answer",
      short: "Combine",
      icon: "merge",
      plan: (done, prompt) => {
        const parts = outputsOf<Work>(done, "work");
        return [{ skill: "combine", instruction: `Combine ${plural(parts.length, "part")} into one answer`, label: "Combine answer", icon: "merge", preview: pagePreview("doc", [{ url: "Answer", lines: parts.map((part) => part.label) }]), params: { prompt, parts }, ms: 3000, role: "orchestrator" }];
      },
    },
  ],
  skills: {
    plan: async ({ prompt }: { prompt: string }) => {
      const reply = await complete([
        { role: "system", content: `You split a person's request into 3 to ${MAX_PARTS} independent parts that different workers can do at the same time, without seeing each other's work. Reply with JSON only: {"parts":[{"label":"2 to 4 words","instruction":"one sentence telling the worker exactly what to produce"}]}` },
        { role: "user", content: prompt },
      ], 600);
      const parts = partsOf(prompt, [jsonFrom<{ parts: Part[] }>(reply)]);
      return { found: { pages: [parts.map((part) => part.label)] }, summary: `Split into ${plural(parts.length, "part")}: ${parts.map((part) => part.label).join(", ")}`, short: plural(parts.length, "part"), data: { parts } };
    },
    work: async ({ prompt, label, instruction }: { prompt: string } & Part) => {
      const reply = await complete([
        { role: "system", content: `You are one of several workers on a shared job. Do only your part, specifically and concretely. Reply with JSON only: {"bullets":["3 to 5 short findings, each under 15 words"],"text":"one paragraph, under 90 words"}` },
        { role: "user", content: `The whole job: ${prompt}\n\nYour part (${label}): ${instruction}` },
      ], 700);
      const { bullets = [], text = "" } = jsonFrom<Partial<Work>>(reply);
      return { found: { pages: [bullets.slice(0, 3)] }, summary: bullets[0] ?? words(text, 14), short: plural(bullets.length, "finding"), data: { label, bullets, text } };
    },
    combine: async ({ prompt, parts }: { prompt: string; parts: Work[] }) => {
      const reply = await complete([
        { role: "system", content: `Combine the workers' parts into one answer for the person. Reply with JSON only: {"headline":"the answer in one sentence","answer":"two or three short paragraphs","next":["up to 4 concrete next steps"]}` },
        { role: "user", content: `The job: ${prompt}\n\n${parts.map((part) => `## ${part.label}\n${part.bullets.map((bullet) => `- ${bullet}`).join("\n")}\n${part.text}`).join("\n\n")}` },
      ], 1200);
      const { headline = "Done.", answer = "", next = [] } = jsonFrom<{ headline?: string; answer?: string; next?: string[] }>(reply);
      const result: Result = {
        headline,
        stats: [
          { value: String(parts.length), label: "parts worked at once" },
          { value: String(parts.reduce((sum, part) => sum + part.bullets.length, 0)), label: "findings" },
          { value: "Live", label: "DeepSeek-V4.1-Flash" },
        ],
        sections: [
          { title: "Answer", kind: "text", body: answer },
          ...(next.length ? [{ title: "Next steps", kind: "list" as const, items: next }] : []),
          { title: "What each board found", kind: "cards", cards: parts.map((part) => ({ title: part.label, subtitle: plural(part.bullets.length, "finding"), lines: part.bullets })) },
        ],
      };
      return { found: { pages: [[headline]] }, summary: headline, short: "Answer ✓", data: result };
    },
  },
};
