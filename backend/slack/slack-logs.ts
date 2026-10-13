export type SlackLogEntry = {
  method: string;
  path: string;
  response: unknown;
  timestamp: string;
};

export function createSlackLogs() {
  const entries: SlackLogEntry[] = [];

  function add(method: string, path: string, response: unknown) {
    entries.push({ method, path, response, timestamp: new Date().toISOString() });
  }

  function getAll() {
    return [...entries];
  }

  return { add, getAll };
}