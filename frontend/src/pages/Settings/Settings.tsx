import { useState } from "react";
import { PageHeader, Panel, SourceLogo, StatusDot, SubTabs } from "../../components/ui";
import { SourceCard } from "./SourceCard";
import "./Settings.css";

type Theme = "sand" | "dark";

export function SettingsPage() {
  const [theme, setTheme] = useState<Theme>(() => (document.documentElement.dataset.theme === "dark" ? "dark" : "sand"));

  function chooseTheme(nextTheme: Theme) {
    setTheme(nextTheme);
    document.documentElement.dataset.theme = nextTheme;
    try {
      localStorage.setItem("continuum-theme", nextTheme);
    } catch {
      // Keep the selected theme active for this session if storage is unavailable.
    }
  }

  return (
    <>
      <PageHeader title="Settings" />
      <div className="block">
        <Panel title="Connections">
          <ul className="rows">
            <SourceCard source="jira" name="Jira" />
            <SourceCard source="slack" name="Slack" />
            <SourceCard source="github" name="GitHub" />
            <li className="source-row is-planned">
              <SourceLogo name="outlook" />
              <div className="source-name"><h3>Outlook</h3></div>
              <span className="source-state"><StatusDot tone="off" />Not built yet</span>
            </li>
          </ul>
        </Panel>
        <Panel
          title="Theme"
          className="theme-panel"
          actions={<SubTabs label="Theme" items={[{ value: "sand", label: "Sand" }, { value: "dark", label: "Dark" }]} value={theme} onChange={chooseTheme} />}
        />
      </div>
    </>
  );
}
