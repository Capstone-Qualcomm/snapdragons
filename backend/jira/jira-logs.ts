import { randomBytes } from "node:crypto";

export type JiraLog = {
  id: string;
  timestamp: string;
  node: "Q-01";
  method: string;
  path: string;
  values: unknown;
};

export function createJiraLogs() {
  const logs: JiraLog[] = [];

  function add(method: string, path: string, values: unknown): void {
    logs.unshift({ id: randomBytes(8).toString("hex"), timestamp: new Date().toISOString(), node: "Q-01", method, path, values });
    if (logs.length > 100) logs.length = 100;
  }

  function list(): JiraLog[] {
    return logs;
  }

  return { add, list };
}
