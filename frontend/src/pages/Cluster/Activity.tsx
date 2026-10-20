import { useEffect, useState } from "react";
import { SourceLogo } from "../../components/ui";
import { api } from "../../lib/api";
import type { ClusterEvent } from "./cluster";

type SourceName = "jira" | "slack" | "github";
type SyncEvent = { id: number; timestamp: string; status: number; count: number | null };
type Entry = { key: string; at: number; text: string; source: SourceName | null };
const sources: SourceName[] = ["jira", "slack", "github"];

function syncText(event: SyncEvent) {
  if (event.status === 200) return `Loaded ${event.count} ${event.count === 1 ? "item" : "items"}`;
  if (event.status === 401) return "Sign-in required";
  if (event.status === 403) return "Source turned off";
  return `Fetch failed (HTTP ${event.status})`;
}

// Each source backend's sync log, every 3 seconds. A source that can't be
// reached keeps what it last answered.
function useSyncEvents() {
  const [events, setEvents] = useState<Partial<Record<SourceName, SyncEvent[]>>>({});
  useEffect(() => {
    async function load() {
      await Promise.all(sources.map(async (source) => {
        try {
          const { events } = await api<{ events: SyncEvent[] }>(`/api/${source}/activity`);
          setEvents((current) => ({ ...current, [source]: events }));
        } catch {
          // Shown again on the next answer.
        }
      }));
    }
    void load();
    const timer = setInterval(load, 3000);
    return () => clearInterval(timer);
  }, []);
  return events;
}

// What the cluster and the sources did, newest first, in one list.
export function Activity({ events, offset }: { events: ClusterEvent[]; offset: number }) {
  const syncs = useSyncEvents();
  const entries: Entry[] = [
    // Cluster times are the gateway's clock; offset turns them into this browser's.
    ...events.map((event, index) => ({ key: `c${index}-${event.at}`, at: event.at - offset, text: event.text, source: null })),
    ...sources.flatMap((source) => (syncs[source] ?? []).map((event) => ({ key: `${source}${event.id}`, at: new Date(event.timestamp).getTime(), text: syncText(event), source }))),
  ].sort((a, b) => b.at - a.at).slice(0, 40);

  return (
    <section className="activity panel-box" aria-label="Activity">
      <header className="box-head">
        <h2>Activity</h2>
      </header>
      <ol className="activity-rows" aria-live="polite">
        {entries.map((entry) => (
          <li key={entry.key}>
            <time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</time>
            {entry.source ? <SourceLogo name={entry.source} /> : <span className="logo logo-cluster" aria-hidden="true" />}
            <span>{entry.text}</span>
          </li>
        ))}
      </ol>
    </section>
  );
}
