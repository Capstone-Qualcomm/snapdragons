import { useEffect, useState } from "react";
import { apiPath } from "../../lib/urls";
import "./logs.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];
type NodeLog = { id: string; timestamp: string; node: string; method: string; path: string; values: unknown };
type SourceName = "Jira" | "Slack" | "GitHub";
type SyncEvent = { id: number; timestamp: string; status: number; count: number | null; source: SourceName };
const sources = ["Jira", "Slack", "GitHub"] as const;

function eventText(event: SyncEvent) {
  if (event.status === 200) return `Loaded ${event.count} items`;
  if (event.status === 401) return "Sign-in required";
  if (event.status === 403) return "Source turned off";
  return `Fetch failed (HTTP ${event.status})`;
}

export function LogsPage() {
  const [logs, setLogs] = useState<NodeLog[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  const [logsUnavailable, setLogsUnavailable] = useState(false);
  const [activity, setActivity] = useState<SyncEvent[]>([]);
  const [unavailableSources, setUnavailableSources] = useState<SourceName[]>([]);

  useEffect(() => {
    let active = true;
    let loading = false;
    async function loadActivity() {
      if (loading) return;
      loading = true;
      try {
        const results = await Promise.all(sources.map(async (source) => {
          try {
            const response = await fetch(apiPath(`/api/${source.toLowerCase()}/activity`), { cache: "no-store" });
            const result = await response.json() as { events?: Omit<SyncEvent, "source">[] };
            if (!response.ok || !Array.isArray(result.events) || !result.events.every((event) =>
              typeof event.id === "number" && typeof event.timestamp === "string" && typeof event.status === "number" &&
              (event.count === null || typeof event.count === "number"))) throw new Error("Activity unavailable");
            return { source, events: result.events.map((event) => ({ ...event, source })), available: true };
          } catch {
            return { source, events: [] as SyncEvent[], available: false };
          }
        }));
        if (!active) return;
        setActivity(results.flatMap((result) => result.events).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 15));
        setUnavailableSources(results.filter((result) => !result.available).map((result) => result.source));
      } finally {
        loading = false;
      }
    }
    void loadActivity();
    const interval = window.setInterval(() => void loadActivity(), 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadLogs() {
      try {
        const response = await fetch(apiPath("/api/jira/logs"), { cache: "no-store" });
        const result = await response.json() as { logs?: NodeLog[] };
        if (!response.ok || !Array.isArray(result.logs)) throw new Error("Logs unavailable");
        if (active) {
          setLogs(result.logs);
          setLogsUnavailable(false);
        }
      } catch {
        if (active) setLogsUnavailable(true);
      }
    }
    void loadLogs();
    const interval = window.setInterval(() => void loadLogs(), 3000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, []);

  return (
    <section className="logs-view" aria-label="Logs">
      <details className="sync-activity" open>
        <summary>
          <strong>Source sync activity</strong>
          <span className="sync-activity-description">Recent Report fetches</span>
          <span className="sync-activity-chevron" aria-hidden="true">▾</span>
        </summary>
        {unavailableSources.length > 0 && <p className="sync-unavailable" role="status">Activity unavailable: {unavailableSources.join(", ")}</p>}
        {activity.length === 0 ? <p className="sync-empty">{unavailableSources.length === sources.length
          ? "Start the source backends to view sync activity."
          : "No sync attempts recorded yet. Open Report to fetch your sources."}</p> : (
          <ol className="sync-events" aria-live="polite">
            {activity.map((event) => (
              <li key={`${event.source}-${event.id}`}>
                <strong>{event.source}</strong>
                <span className={event.status === 200 ? "sync-success" : "sync-error"}>{eventText(event)}</span>
                <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
              </li>
            ))}
          </ol>
        )}
      </details>
      <div className="logs-grid">
        {nodes.map((node) => (
          <article className="log-card" key={node}>
            <header>
              <span className="node-mark" />
              <h2>{node}</h2>
            </header>
            {node === "Q-01" ? (
              logsUnavailable ? <p>No connection to the log service</p> : logs.length === 0 ? <p>No logs available</p> : (
                <ol className="log-entries" aria-live="polite">
                  {logs.map((log) => (
                    <li className="log-entry" key={log.id}>
                      <button
                        className="log-entry-toggle"
                        type="button"
                        aria-expanded={expandedLogs.has(log.id)}
                        onClick={() => setExpandedLogs((current) => {
                          const next = new Set(current);
                          if (next.has(log.id)) next.delete(log.id);
                          else next.add(log.id);
                          return next;
                        })}
                      >
                        <span className={`log-entry-carrot ${expandedLogs.has(log.id) ? "is-expanded" : ""}`} aria-hidden="true">
                          <svg viewBox="0 0 16 16"><path d="m5 6 3 3 3-3" /></svg>
                        </span>
                        <span className="log-entry-heading">
                        <span className={`log-method log-method-${log.method.toLowerCase()}`}>{log.method}</span>
                        <code>{log.path}</code>
                        <time dateTime={log.timestamp}>{new Date(log.timestamp).toLocaleTimeString()}</time>
                        </span>
                      </button>
                      {expandedLogs.has(log.id) && <pre>{JSON.stringify(log.values, null, 2)}</pre>}
                    </li>
                  ))}
                </ol>
              )
            ) : <p>No logs available</p>}
          </article>
        ))}
      </div>
    </section>
  );
}
