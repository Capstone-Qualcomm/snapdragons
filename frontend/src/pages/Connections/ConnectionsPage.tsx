import { ConnectionsPanel } from "../Today/Connections";
import type { Source } from "../Today/sources";
import { ErrorBanner } from "../../components/ui";
import type { NotionConnection } from "./notion";
import { signInError } from "../Today/Connections";
import { useEffect, useState } from "react";

// Where Today's sources are connected, turned off or disconnected.
export function ConnectionsPage({ sources, counts, notion }: { sources: Source<unknown>[]; counts: Record<string, number>; notion: NotionConnection }) {
  const [signInMessage] = useState(() => signInError("Notion", new URLSearchParams(window.location.search).get("notion") ?? ""));
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("notion")) window.history.replaceState({}, "", window.location.pathname);
  }, []);
  return (
    <div className="page">
      <header className="page-head">
        <div className="page-title">
          <h1>Connections</h1>
          <p className="lede">Connect, turn off or disconnect the accounts and knowledge sources used by the app.</p>
        </div>
      </header>
      <div className="page-body">
        {signInMessage && <ErrorBanner message={signInMessage} />}
        <ConnectionsPanel sources={sources} counts={counts} notion={notion} />
      </div>
    </div>
  );
}
