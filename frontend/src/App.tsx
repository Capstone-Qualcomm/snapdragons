import { useEffect, useState } from "react";
import type { MouseEvent } from "react";
import { About } from "./components/About/About";
import { Icon } from "./components/Icon";
import { appPath } from "./lib/urls";
import { AssistantPage } from "./pages/Assistant/Assistant";
import { useCluster } from "./pages/Cluster/cluster";
import { ClusterPage } from "./pages/Cluster/ClusterPage";
import { ConnectionsPage } from "./pages/Connections/ConnectionsPage";
import { rank, toItems } from "./pages/Today/rank";
import { useSource } from "./pages/Today/sources";
import { TodayPage } from "./pages/Today/TodayPage";

const pages = [
  { path: "assistant", label: "Assistant", icon: "sparkle" },
  { path: "today", label: "Today", icon: "today" },
  { path: "cluster", label: "Cluster", icon: "cluster" },
  { path: "connections", label: "Connections", icon: "plug" },
] as const;
type Page = (typeof pages)[number]["path"];

function pageFromPath(path: string): Page {
  const last = path.split("/").filter(Boolean).at(-1)?.toLowerCase();
  return pages.find((page) => page.path === last)?.path ?? "assistant";
}

function App() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [page, setPage] = useState<Page>(() => pageFromPath(window.location.pathname));
  // One poll of the cluster and one load of each source, shared by every page.
  const { cluster, failed, reload, serverNow } = useCluster();
  const slack = useSource("slack");
  const jira = useSource("jira");
  const github = useSource("github");
  const sources = [slack, jira, github];
  const items = rank(toItems({ slack: slack.items, jira: jira.items, github: github.items }));
  const counts = Object.fromEntries(sources.map((source) => [source.name, items.filter((item) => item.source === source.name).length]));

  useEffect(() => {
    const sync = () => setPage(pageFromPath(window.location.pathname));
    window.addEventListener("popstate", sync);
    return () => window.removeEventListener("popstate", sync);
  }, []);

  useEffect(() => {
    if (!aboutOpen) return;
    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setAboutOpen(false);
    }
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [aboutOpen]);

  // Links inside the app change the page without reloading it.
  function navigate(event: MouseEvent) {
    const link = (event.target as Element).closest?.("a[data-page]");
    if (!link || event.metaKey || event.ctrlKey) return;
    event.preventDefault();
    const next = link.getAttribute("data-page") as Page;
    if (window.location.pathname !== appPath(next)) window.history.pushState({}, "", appPath(next));
    setPage(next);
    setMenuOpen(false);
    window.scrollTo(0, 0);
  }

  const up = cluster?.nodes.filter((node) => node.up).length ?? 0;
  const total = cluster?.nodes.length ?? 0;

  return (
    <div className="app-shell" onClick={navigate}>
      <aside className={menuOpen ? "sidebar is-open" : "sidebar"}>
        <a className="brand" href={appPath("assistant")} data-page="assistant" aria-label="Continuum">
          <span className="brand-mark" aria-hidden="true" />
          Continuum
        </a>
        <button className="menu-button" type="button" aria-label="Menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}>
          <Icon name={menuOpen ? "x" : "menu"} size={20} />
        </button>
        <nav className="nav" aria-label="Pages">
          {pages.map((entry) => (
            <a key={entry.path} href={appPath(entry.path)} data-page={entry.path} aria-current={entry.path === page ? "page" : undefined}>
              <Icon name={entry.icon} size={18} />
              {entry.label}
            </a>
          ))}
        </nav>
        <div className="sidebar-foot">
          <a className="health" href={appPath("cluster")} data-page="cluster" title="Open Cluster">
            <span className={`dot ${!cluster ? "tone-bad" : up === total ? "tone-ok" : "tone-warn"}`} aria-hidden="true" />
            {cluster ? (
              <span>
                <strong>{up}</strong> of {total} boards online
              </span>
            ) : (
              <span>Cluster offline</span>
            )}
          </a>
          <button className="button quiet small about-button" type="button" onClick={() => setAboutOpen(true)}>
            <Icon name="info" size={16} />
            About
          </button>
        </div>
      </aside>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}

      <main className="content">
        {page === "assistant" && <AssistantPage cluster={cluster} failed={failed} reload={reload} serverNow={serverNow} />}
        {page === "today" && <TodayPage sources={sources} cluster={cluster} offset={serverNow() - Date.now()} />}
        {page === "cluster" && <ClusterPage cluster={cluster} failed={failed} reload={reload} serverNow={serverNow} />}
        {page === "connections" && <ConnectionsPage sources={sources} counts={counts} />}
      </main>
    </div>
  );
}

export default App;
