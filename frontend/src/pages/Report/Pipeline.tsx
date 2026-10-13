import { appPath } from "../../lib/urls";
import type { Source } from "./useSlackSource";
import { ago } from "./useSlackSource";

const jiraBrowse = "https://wisc-team-n0186djm.atlassian.net/browse/";

type Tone = "ok" | "busy" | "warn" | "bad" | "off";

type Stage = {
  name: string;
  tone: Tone;
  state: string;
  detail: string;
  action?: { label: string; href?: string; onClick?: () => void };
};

const labels: Record<"jira" | "slack", { title: string; noun: string }> = {
  jira: { title: "Jira", noun: "assigned" },
  slack: { title: "Slack", noun: "waiting on you" },
};

function sourceStage(source: Source<unknown>, now: number, itemCount = source.items.length): Stage {
  const { title, noun } = labels[source.name];
  switch (source.status) {
    case "loading":
      return { name: title, tone: "busy", state: "Syncing", detail: "Loading…" };
    case "unconfigured":
      return { name: title, tone: "off", state: "Not set up", detail: `Add ${title} OAuth keys to the backend .env` };
    case "disconnected":
      return { name: title, tone: "off", state: "Not connected", detail: "Sign in to pull items", action: { label: `Connect ${title}`, href: appPath(`auth/${source.name}/start`) } };
    case "disabled":
      return { name: title, tone: "warn", state: "Turned off", detail: "Connected but excluded from Report", action: { label: "Turn on", onClick: () => void source.enable() } };
    case "error":
      return { name: title, tone: "bad", state: "Failed", detail: source.error, action: { label: "Retry", onClick: () => void source.reload() } };
    case "ready":
      return { name: title, tone: "ok", state: `${itemCount} ${noun}`, detail: `Synced ${source.loadedAt ? ago(source.loadedAt, now) : ""}`, action: { label: "Sync ↻", onClick: () => void source.reload() } };
  }
}

function plannedStage(name: string, detail: string, ticket: string): Stage {
  return { name, tone: "off", state: "On the workbench", detail, action: { label: `${ticket} ↗`, href: jiraBrowse + ticket } };
}

function StageCell({ stage }: { stage: Stage }) {
  const { action } = stage;
  return (
    <li className={`stage tone-${stage.tone}`}>
      <div className="stage-top">
        <span className="led" aria-hidden="true" />
        <span className="stage-name">{stage.name}</span>
      </div>
      <strong className="stage-state">{stage.state}</strong>
      <span className="stage-detail" title={stage.detail}>{stage.detail}</span>
      {action && (action.href ? (
        <a className="stage-action" href={action.href} target={action.href.startsWith("http") ? "_blank" : undefined} rel="noreferrer">{action.label}</a>
      ) : (
        <button className="stage-action" type="button" onClick={action.onClick}>{action.label}</button>
      ))}
    </li>
  );
}

export function Pipeline({ slack, jiraCount, now }: { slack: Source<unknown>; jiraCount: number; now: number }) {
  const groups: Array<{ label: string; stages: Stage[] }> = [
    { label: "Sources", stages: [sourceStage({ name: "jira", status: "ready", items: [], error: "", loadedAt: null, reload: async () => {}, enable: async () => {} }, now, jiraCount), sourceStage(slack, now), plannedStage("Outlook", "Today's email into the list", "QT1S-27")] },
    { label: "Cluster", stages: [plannedStage("Task queue", "Workers claim tasks from it", "QT1S-8"), plannedStage("Uno Q nodes", "6 boards in the mail", "QT1S-11")] },
    { label: "Output", stages: [plannedStage("Ranking", "One LLM call orders the list", "QT1S-26")] },
  ];

  return (
    <section className="pipeline" aria-label="How the assistant is running">
      {groups.map((group, index) => (
        <div className="pipeline-group" key={group.label}>
          <h2 className="pipeline-label">{String(index + 1).padStart(2, "0")} {group.label}</h2>
          <ol className="pipeline-stages">
            {group.stages.map((stage) => <StageCell key={stage.name} stage={stage} />)}
          </ol>
        </div>
      ))}
    </section>
  );
}
