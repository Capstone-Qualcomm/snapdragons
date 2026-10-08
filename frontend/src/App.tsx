import { useEffect, useState } from "react";
import { ConsolePage } from "./pages/Console/Console";
import { LogsPage } from "./pages/Logs/Logs";
import { ReportPage } from "./pages/Report/Report";
import { About } from "./components/About/About";

type View = "Console" | "Report" | "Logs";

const views: View[] = ["Console", "Report", "Logs"];

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
    const path = "/" + nextView.toLowerCase();
    if (window.location.pathname !== path) {
      window.history.pushState({}, "", path);
    }
    setView(nextView);
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="/console"
          aria-label="Continuum console"
          onClick={(event) => {
            event.preventDefault();
            navigateTo("Console");
          }}
        >
          <span className="brand-mark" aria-hidden="true">
            <i />
          </span>
          <span>CONTINUUM</span>
        </a>
        <nav className="nav-links" aria-label="Main navigation">
          {views.map((item) => (
            <button
              className={view === item ? "nav-link active" : "nav-link"}
              key={item}
              onClick={() => navigateTo(item)}
              aria-current={view === item ? "page" : undefined}
            >
              {item}
            </button>
          ))}
        </nav>
        <button
          className="about-button"
          type="button"
          aria-label="About"
          title="About"
          onClick={() => setAboutOpen(true)}
        >
          ?
        </button>
      </header>

      {aboutOpen && <About onClose={() => setAboutOpen(false)} />}

      <section className="view-content" id={view.toLowerCase()}>
        {view === "Console" && <ConsolePage />}
        {view === "Report" && <ReportPage />}
        {view === "Logs" && <LogsPage />}
      </section>
    </main>
  );
}

export default App;
