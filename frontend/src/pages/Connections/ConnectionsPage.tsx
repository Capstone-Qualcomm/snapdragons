import { ConnectionsPanel } from "../Today/Connections";
import type { Source } from "../Today/sources";

// Where Today's sources are connected, turned off or disconnected.
export function ConnectionsPage({ sources, counts }: { sources: Source<unknown>[]; counts: Record<string, number> }) {
  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Connections</h1>
          <p className="lede">The accounts Today reads from. Connect, turn off or disconnect each one here.</p>
        </div>
      </header>
      <div className="page-body">
        <ConnectionsPanel sources={sources} counts={counts} />
      </div>
    </div>
  );
}
