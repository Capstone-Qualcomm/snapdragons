export type SyncEvent = {
  id: number;
  timestamp: string;
  status: number;
  count: number | null;
};

export function createSourceActivity() {
  const events: SyncEvent[] = [];
  let nextId = 1;

  function add(status: number, count: number | null = null) {
    events.unshift({ id: nextId++, timestamp: new Date().toISOString(), status, count });
    if (events.length > 50) events.length = 50;
  }

  function list(): SyncEvent[] {
    return [...events];
  }

  return { add, list };
}
