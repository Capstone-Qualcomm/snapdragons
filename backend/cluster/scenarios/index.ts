import type { Scenario, SkillContext, StepOutput } from "../plan.ts";
import { business } from "./business.ts";
import { engineer } from "./engineer.ts";
import { research } from "./research.ts";
import { student } from "./student.ts";
import { ask } from "./ask.ts";
import { interviews } from "./interviews.ts";

// Every scenario the Assistant can run, in the order the page offers them.
export const SCENARIOS: Scenario[] = [interviews, ask, student, engineer, business, research];

export const scenarioById = (id: string) => SCENARIOS.find((scenario) => scenario.id === id);

// Runs one step's skill on its scenario's demo data.
const NO_CONTEXT: SkillContext = { partial: null, report: () => {} };

export function runSkill(scenario: string, skill: string, params: unknown, context = NO_CONTEXT): StepOutput | Promise<StepOutput> {
  const run = scenarioById(scenario)?.skills[skill];
  if (!run) throw new Error(`No skill ${skill} in scenario ${scenario}.`);
  return run(params, context);
}

// What the page needs to offer a scenario before it runs.
export function describeScenarios() {
  return SCENARIOS.map(({ id, audience, icon, title, prompt, data, stages, sample }) => ({ id, audience, icon, title, prompt, data, hasSample: Boolean(sample), stages: stages.map(({ label, short, icon }) => ({ label, short, icon })) }));
}
