import { useCallback, useEffect, useState } from "react";
import { EmptyState, ErrorBanner, PageHeader, SkeletonRows, SourceLogo, StatusDot } from "../../components/ui";
import { api } from "../../lib/api";
import "./logs.css";

type JiraRequest = { id: string; timestamp: string; method: string; path: string; values: unknown };
type SourceName = "jira" | "slack" | "github";
type SyncEvent = { id: number; timestamp: string; status: number; count: number | null; source: SourceName };
const sources: Record<SourceName, string> = { jira: "Jira", slack: "Slack", github: "GitHub" };

function eventText(event: SyncEvent) {
  if (event.status === 200) return `Loaded ${event.count} ${event.count === 1 ? "item" : "items"}`;
  if (event.status === 401) return "Sign-in required";
  if (event.status === 403) return "Source turned off";
  return `Fetch failed (HTTP ${event.status})`;
}

// Calls load now and every 3 seconds, skipping a tick while the last call is still out.
function usePoll(load: () => Promise<void>) {
  useEffect(() => {
    let loading = false;
    async function tick() {
      if (loading) return;
      loading = true;
      await load().finally(() => { loading = false; });
    }
    void tick();
    const interval = window.setInterval(() => void tick(), 3000);
    return () => window.clearInterval(interval);
  }, [load]);
}

async function loadActivity() {
  const results = await Promise.all((Object.keys(sources) as SourceName[]).map(async (source) => {
    try {
      const { events } = await api<{ events: Omit<SyncEvent, "source">[] }>(`/api/${source}/activity`);
      return { source, events: events.map((event) => ({ ...event, source })) };
    } catch {
      return { source, events: null };
    }
  }));
  return {
    events: results.flatMap((result) => result.events ?? []).sort((a, b) => b.timestamp.localeCompare(a.timestamp)).slice(0, 40),
    unavailable: results.filter((result) => !result.events).map((result) => sources[result.source]),
  };
}

export function LogsPage() {
  const [activity, setActivity] = useState<{ events: SyncEvent[]; unavailable: string[] } | null>(null);
  // undefined until the first answer, null when the Jira backend can't be reached.
  const [requests, setRequests] = useState<JiraRequest[] | null>();
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  usePoll(useCallback(async () => setActivity(await loadActivity()), []));
  usePoll(useCallback(async () => {
    try {
      setRequests((await api<{ logs: JiraRequest[] }>("/api/jira/logs")).logs);
    } catch {
      setRequests(null);
    }
  }, []));

  function toggle(id: string) {
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  const allUnavailable = activity?.unavailable.length === Object.keys(sources).length;

  return (
    <>
      <PageHeader title="Logs" />
      <div className="block logs-columns">
        <details className="panel sync-activity" open>
          <summary className="panel-head">
            <h2>Source sync activity</h2>
            {activity && <span className="count">{activity.events.length}</span>}
            <svg className="sync-activity-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>
          </summary>
          {activity && activity.unavailable.length > 0 && !allUnavailable && (
            <ErrorBanner message={`Activity unavailable: ${activity.unavailable.join(", ")}`} />
          )}
          {!activity ? <SkeletonRows /> : allUnavailable ? (
            <ErrorBanner message="Could not reach the source backends." />
          ) : activity.events.length === 0 ? (
            <EmptyState>No syncs yet.</EmptyState>
          ) : (
            <ol className="rows sync-events" aria-live="polite">
              {activity.events.map((event) => (
                <li key={`${event.source}-${event.id}`}>
                  <time dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
                  <SourceLogo name={event.source} />
                  <strong>{sources[event.source]}</strong>
                  <StatusDot tone={event.status === 200 ? "ok" : event.status === 403 || event.status === 401 ? "warn" : "bad"} />
                  <span>{eventText(event)}</span>
                </li>
              ))}
            </ol>
          )}
        </details>

        <section className="panel" aria-labelledby="jira-requests-title">
          <header className="panel-head">
            <SourceLogo name="jira" />
            <h2 id="jira-requests-title">Jira requests</h2>
            {requests && <span className="count">{requests.length}</span>}
          </header>
          {requests === undefined ? <SkeletonRows /> : requests === null ? (
            <ErrorBanner message="Could not reach the Jira backend." />
          ) : requests.length === 0 ? (
            <EmptyState>No Jira requests yet.</EmptyState>
          ) : (
            <ol className="rows jira-requests" aria-live="polite">
              {requests.map((request) => (
                <li key={request.id}>
                  <button className="jira-request" type="button" aria-expanded={expanded.has(request.id)} onClick={() => toggle(request.id)}>
                    <time dateTime={request.timestamp}>{new Date(request.timestamp).toLocaleTimeString()}</time>
                    <span className={`method method-${request.method.toLowerCase()}`}>{request.method}</span>
                    <code>{request.path}</code>
                  </button>
                  {expanded.has(request.id) && <pre>{JSON.stringify(request.values, null, 2)}</pre>}
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </>
  );
}
