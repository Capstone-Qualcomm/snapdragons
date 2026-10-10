import { useEffect, useState } from "react";
import "./logs.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];
type NodeLog = { id: string; timestamp: string; node: string; method: string; path: string; values: unknown };

export function LogsPage() {
  const [logs, setLogs] = useState<NodeLog[]>([]);
  const [expandedLogs, setExpandedLogs] = useState<Set<string>>(() => new Set());
  const [logsUnavailable, setLogsUnavailable] = useState(false);

  useEffect(() => {
    let active = true;
    async function loadLogs() {
      try {
        const response = await fetch("/api/jira/logs", { cache: "no-store" });
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
    <section className="logs-view" aria-label="Node logs">
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
