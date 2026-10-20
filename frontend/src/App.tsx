import { useEffect, useState } from "react";
import { ConsolePage } from "./pages/Console/Console";
import { LogsPage } from "./pages/logs/logs";
import { ReportPage } from "./pages/Report/Report";
import { About } from "./components/About/About";
import { SettingsPage } from "./pages/Settings/Settings";
import { appPath } from "./lib/urls";
import { SubTabs } from "./components/ui";

type View = "Console" | "Report" | "Logs" | "Settings";

const views: View[] = ["Console", "Report", "Logs", "Settings"];

function viewFromPath(path: string): View {
  const pathView = path.split("/").filter(Boolean).at(-1)?.toLowerCase();
  return views.find((view) => view.toLowerCase() === pathView) ?? "Console";
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
          href={appPath("console")}
          aria-label="Continuum console"
          onClick={(event) => {
            event.preventDefault();
            navigateTo("Console");
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

      <main className="view-content" id={view.toLowerCase()}>
        {view === "Console" && <ConsolePage />}
        {view === "Report" && <ReportPage />}
        {view === "Logs" && <LogsPage />}
        {view === "Settings" && <SettingsPage />}
      </main>
    </div>
  );
}

export default App;
