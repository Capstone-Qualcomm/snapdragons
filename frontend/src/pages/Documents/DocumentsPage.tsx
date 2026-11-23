import { useEffect, useRef, useState } from "react";
import { api } from "../../lib/api";
import { appPath } from "../../lib/urls";
import { ErrorBanner, SourceLogo, StatusDot } from "../../components/ui";
import { Icon } from "../../components/Icon";
import type { NotionPage, Source } from "../Today/sources";
import "./Documents.css";

const pageLimit = 20;
const documentApps = [{ id: "notion", label: "Notion" }] as const;

type SearchState = {
  query: string;
  status: "idle" | "loading" | "ready" | "error";
  pages: NotionPage[];
  error: string;
};

function editedAt(value: string) {
  const time = Date.parse(value);
  return Number.isFinite(time) && time > 0
    ? new Intl.DateTimeFormat([], { month: "short", day: "numeric", year: "numeric" }).format(time)
    : "Date unavailable";
}

export function DocumentsPage({ notion }: { notion: Source<NotionPage> }) {
  const [query, setQuery] = useState("");
  const [selectedApps, setSelectedApps] = useState<string[] | null>(null);
  const [search, setSearch] = useState<SearchState>({ query: "", status: "idle", pages: [], error: "" });
  const filterRef = useRef<HTMLDetailsElement>(null);
  const normalizedQuery = query.trim();

  useEffect(() => {
    if (!normalizedQuery || notion.status !== "ready") {
      setSearch({ query: normalizedQuery, status: "idle", pages: [], error: "" });
      return;
    }

    let active = true;
    setSearch({ query: normalizedQuery, status: "loading", pages: [], error: "" });
    const timer = window.setTimeout(() => {
      void api<{ pages: NotionPage[] }>(`/api/notion/search?q=${encodeURIComponent(normalizedQuery)}`)
        .then(({ pages }) => {
          if (active) setSearch({ query: normalizedQuery, status: "ready", pages, error: "" });
        })
        .catch((cause) => {
          if (active) setSearch({ query: normalizedQuery, status: "error", pages: [], error: (cause as Error).message });
        });
    }, 250);

    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [normalizedQuery, notion.status]);

  useEffect(() => {
    function closeFilter(event: PointerEvent) {
      if (event.target instanceof Node && !filterRef.current?.contains(event.target)) {
        if (filterRef.current) filterRef.current.open = false;
      }
    }
    function closeFilterOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape" && filterRef.current) filterRef.current.open = false;
    }
    document.addEventListener("pointerdown", closeFilter);
    document.addEventListener("keydown", closeFilterOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeFilter);
      document.removeEventListener("keydown", closeFilterOnEscape);
    };
  }, []);

  const searching = Boolean(normalizedQuery);
  const searchIsCurrent = search.query === normalizedQuery;
  const loadingSearch = searching && (!searchIsCurrent || search.status === "loading");
  const searchError = searching && searchIsCurrent && search.status === "error" ? search.error : "";
  const allDocuments = (searching
    ? searchIsCurrent && search.status === "ready" ? search.pages : []
    : notion.items).map((document) => ({ ...document, app: "notion" }));
  const matchingDocuments = allDocuments.filter((document) => selectedApps === null || selectedApps.includes(document.app));
  const documents = matchingDocuments.slice(0, pageLimit);

  function toggleApp(app: string) {
    const current = new Set(selectedApps ?? documentApps.map(({ id }) => id));
    if (current.has(app)) current.delete(app);
    else current.add(app);
    const next = [...current];
    setSelectedApps(next.length === documentApps.length ? null : next);
  }

  return (
    <div className="page documents-page">
      <header className="page-head">
        <div className="page-title">
          <h1>Documents</h1>
          <p className="lede">Browse documents from connected sources. Search by title to find documents beyond the first 20.</p>
        </div>
        {notion.status === "ready" && (
          <button className="button quiet documents-refresh" type="button" disabled={notion.syncing} onClick={() => void notion.reload()}>
            <Icon name="restart" size={15} />
            {notion.syncing ? "Refreshing" : "Refresh documents"}
          </button>
        )}
      </header>

      <div className="documents-search">
        <Icon name="search" size={18} />
        <label className="sr-only" htmlFor="document-search">Search documents</label>
        <input
          id="document-search"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search documents"
          disabled={notion.status !== "ready"}
        />
        {searching && <span className="documents-search-note">Title search</span>}
        <details className="documents-filter" ref={filterRef}>
          <summary className="documents-filter-button" aria-label="Filter documents by app">
            <Icon name="filter" size={16} />
            Filter
            {selectedApps !== null && <span className="documents-filter-count">{selectedApps.length}</span>}
          </summary>
          <div className="documents-filter-menu" role="group" aria-label="Filter by app">
            <strong>Apps</strong>
            {documentApps.map((app) => (
              <label className="documents-filter-option" key={app.id}>
                <input
                  type="checkbox"
                  checked={selectedApps === null || selectedApps.includes(app.id)}
                  onChange={() => toggleApp(app.id)}
                />
                <SourceLogo name="notion" />
                {app.label}
              </label>
            ))}
            {selectedApps !== null && <button className="text-button" type="button" onClick={() => setSelectedApps(null)}>All apps</button>}
          </div>
        </details>
      </div>

      {notion.status === "unconfigured" && (
        <div className="documents-state">
          <SourceLogo name="notion" />
          <strong>Document sources aren’t set up on this server.</strong>
          <span>Ask the server administrator to configure a document source.</span>
        </div>
      )}
      {notion.status === "disconnected" && (
        <div className="documents-state">
          <SourceLogo name="notion" />
          <strong>Connect a document source to browse shared files.</strong>
          <a className="button" href={appPath("auth/notion/start")}>Connect documents</a>
        </div>
      )}
      {notion.status === "disabled" && (
        <div className="documents-state">
          <SourceLogo name="notion" />
          <strong>The document source is turned off.</strong>
          <button className="button" type="button" disabled={notion.syncing} onClick={() => void notion.setEnabled(true)}>Turn on documents</button>
        </div>
      )}
      {notion.status === "loading" && (
        <div className="documents-state" role="status"><StatusDot tone="busy" /> Loading shared documents…</div>
      )}
      {notion.status === "error" && <ErrorBanner message="Documents couldn’t be loaded." onRetry={() => void notion.reload()} />}
      {searchError && <ErrorBanner message="Document search failed. Try again." />}

      {notion.status === "ready" && (
        <>
          {loadingSearch ? (
            <div className="documents-state" role="status"><StatusDot tone="busy" /> Searching document titles…</div>
          ) : documents.length ? (
            <ul className="documents-grid" aria-label="Documents">
              {documents.map((document) => (
                <li key={document.id}>
                  <a className="document-card" href={document.url} target="_blank" rel="noreferrer" title={`Open ${document.title}`}>
                    <span className="document-card-top">
                      <span className="document-logo"><SourceLogo name="notion" /></span>
                      <Icon name="launch" size={15} className="document-launch" />
                    </span>
                    <strong>{document.title}</strong>
                    <span className="document-card-meta">Edited {editedAt(document.updatedAt)}</span>
                  </a>
                </li>
              ))}
            </ul>
          ) : !searchError && (
            <div className="documents-state">
              {searching ? `No documents found for “${normalizedQuery}”.` : "No documents were returned. Share documents with a connected source, then refresh."}
            </div>
          )}
        </>
      )}
    </div>
  );
}
