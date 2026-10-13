import "./Console.css";

const nodes = ["Q-01", "Q-02", "Q-03", "Q-04", "Q-05", "Q-06"];

export function ConsolePage() {
  return (
    <div className="node-grid" aria-label="Six node console">
      {nodes.map((node) => (
        <article className="node-card" key={node}>
          <header className="node-card-header">
            <span className="node-mark" />
            <h1>{node}</h1>
            <span className="node-role">NODE</span>
          </header>
          <div className="node-empty">Waiting for node connection</div>
        </article>
      ))}
    </div>
  );
}
