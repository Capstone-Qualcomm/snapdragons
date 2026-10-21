import { useEffect, useState } from "react";
import { ClusterPage } from "./pages/Cluster/ClusterPage";
import { TodayPage } from "./pages/Today/Today";
import { About } from "./components/About/About";
import { appPath } from "./lib/urls";
import { SubTabs } from "./components/ui";

type View = "Today" | "Cluster";

const views: View[] = ["Today", "Cluster"];

function viewFromPath(path: string): View {
  const pathView = path.split("/").filter(Boolean).at(-1)?.toLowerCase();
  return views.find((view) => view.toLowerCase() === pathView) ?? "Today";
}

function App() {
  const [aboutOpen, setAboutOpen] = useState(false);
  const [view, setView] = useState<View>(() =>
    viewFromPath(window.location.pathname),
  );

  useEffect(() => {
    const syncView = () => setView(viewFromPath(window.location.pathname));
    window.addEventListener("popstate", syncView);
    return () => window.removeEventListener("popstate", syncView);
  }, []);

  useEffect(() => {
    if (!aboutOpen) return;

    function closeOnEscape(event: KeyboardEvent) {
      if (event.key === "Escape") setAboutOpen(false);
    }

    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [aboutOpen]);

  function navigateTo(nextView: View) {
    const path = appPath(nextView.toLowerCase());
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setView(nextView);
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href={appPath("today")}
          aria-label="Continuum"
          onClick={(event) => {
            event.preventDefault();
            navigateTo("Today");
          }}
        >
          <span className="brand-mark" aria-hidden="true" />
          Continuum
        </a>
        <SubTabs
          label="Main navigation"
          nav
          items={views.map((item) => ({ value: item, label: item }))}
          value={view}
          onChange={navigateTo}
        />
        <button className="header-button" type="button" aria-label="About Continuum" title="About" onClick={() => setAboutOpen(true)}>
          ?
        </button>
      </header>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}

      {/* Today stays mounted behind Cluster, so its list, edits and refresh carry on. */}
      <main className="view-content" id="today" hidden={view !== "Today"}>
        <TodayPage active={view === "Today"} onOpenCluster={() => navigateTo("Cluster")} />
      </main>
      {view === "Cluster" && (
        <main className="view-content" id="cluster">
          <ClusterPage />
        </main>
      )}
    </div>
  );
}

export default App;
