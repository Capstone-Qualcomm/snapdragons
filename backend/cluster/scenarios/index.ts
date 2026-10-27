import type { Scenario, StepOutput } from "../plan.ts";
import { business } from "./business.ts";
import { engineer } from "./engineer.ts";
import { hiring } from "./hiring.ts";
import { research } from "./research.ts";
import { student } from "./student.ts";
import { ask } from "./ask.ts";

// Every scenario the Assistant can run, in the order the page offers them.
export const SCENARIOS: Scenario[] = [ask, student, engineer, hiring, business, research];

export const scenarioById = (id: string) => SCENARIOS.find((scenario) => scenario.id === id);

// Runs one step's skill on its scenario's demo data.
export function runSkill(scenario: string, skill: string, params: unknown): StepOutput | Promise<StepOutput> {
  const run = scenarioById(scenario)?.skills[skill];
  if (!run) throw new Error(`No skill ${skill} in scenario ${scenario}.`);
  return run(params);
}

// What the page needs to offer a scenario before it runs.
export function describeScenarios() {
  return SCENARIOS.map(({ id, audience, icon, title, prompt, data, stages }) => ({ id, audience, icon, title, prompt, data, stages: stages.map(({ label, short, icon }) => ({ label, short, icon })) }));
}
