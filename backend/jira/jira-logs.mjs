import { randomBytes } from "node:crypto";

export function createJiraLogs() {
  const logs = [];

  function add(method, path, values) {
    logs.unshift({ id: randomBytes(8).toString("hex"), timestamp: new Date().toISOString(), node: "Q-01", method, path, values });
    if (logs.length > 100) logs.length = 100;
  }

  function list() {
    return logs;
  }

  return { add, list };
}
