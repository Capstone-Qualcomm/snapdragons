import "./logs.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

export function LogsPage() {
  return (
    <section className="logs-view" aria-label="Node logs">
      <div className="logs-grid">
        {nodes.map((node) => (
          <article className="log-card" key={node}>
            <header>
              <span className="node-mark" />
              <h2>{node}</h2>
            </header>
            <p>No logs available</p>
          </article>
        ))}
      </div>
    </section>
  );
}
