import { useEffect, useState } from "react";
import { SourceLogo } from "../../components/ui";
import { api } from "../../lib/api";
import { titles } from "../Today/sources";
import type { SourceName } from "../Today/sources";
import { describeEvent } from "./cluster";
import type { ClusterEvent, Task } from "./cluster";

type SyncEvent = { id: number; timestamp: string; status: number; count: number | null };
type Entry = { key: string; at: number; text: string; source: SourceName | null };
const sources: SourceName[] = ["jira", "slack", "github", "outlook"];

function syncText(event: SyncEvent) {
  if (event.status === 200) return `Loaded ${event.count} ${event.count === 1 ? "item" : "items"}`;
  if (event.status === 401) return "Sign-in required";
  if (event.status === 403) return "Source turned off";
  return `Fetch failed (HTTP ${event.status})`;
}

// Each source backend's sync log, every 3 seconds. A source that can't be
// reached keeps what it last answered, and is named in unreachable.
function useSyncEvents() {
  const [events, setEvents] = useState<Partial<Record<SourceName, SyncEvent[]>>>({});
  const [unreachable, setUnreachable] = useState<SourceName[]>([]);
  useEffect(() => {
    async function load() {
      const failed = await Promise.all(sources.map(async (source) => {
        try {
          const { events } = await api<{ events: SyncEvent[] }>(`/api/${source}/activity`);
          setEvents((current) => ({ ...current, [source]: events }));
          return [];
        } catch {
          return [source];
        }
      }));
      setUnreachable(failed.flat());
    }
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);
  return { events, unreachable };
}

// What the cluster and the sources did, newest first, in plain sentences.
export function Activity({ events, tasks, offset }: { events: ClusterEvent[]; tasks: Task[]; offset: number }) {
  const { events: syncs, unreachable } = useSyncEvents();
  const entries: Entry[] = [
    // Cluster times are the gateway's clock; offset turns them into this browser's.
    ...events.map((event, index) => ({ key: `c${index}-${event.at}`, at: event.at - offset, text: describeEvent(event.text, tasks), source: null })),
    ...sources.flatMap((source) => (syncs[source] ?? []).map((event) => ({ key: `${source}${event.id}`, at: new Date(event.timestamp).getTime(), text: syncText(event), source }))),
  ]
    // An entry without a usable time would make toISOString throw and blank the whole app.
    .filter((entry) => Number.isFinite(entry.at))
    .sort((a, b) => b.at - a.at)
    .slice(0, 40);

  return (
    <section className="panel activity" aria-labelledby="activity-title">
      <header className="panel-head">
        <h2 id="activity-title">Activity</h2>
      </header>
      {unreachable.length > 0 && (
        <p className="notice" role="status">
          {unreachable.map((source) => titles[source]).join(", ")} activity could not be loaded. Showing what came in before.
        </p>
      )}
      {entries.length === 0 ? (
        <p className="panel-empty">Nothing has happened yet.</p>
      ) : (
        <ol className="activity-rows" aria-label="Activity" aria-live="polite">
          {entries.map((entry) => (
            <li key={entry.key}>
              <time className="num" dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
              {entry.source ? <SourceLogo name={entry.source} /> : <span className="logo logo-cluster" aria-hidden="true" />}
              <span>{entry.source ? `${titles[entry.source]}: ${entry.text}` : entry.text}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
