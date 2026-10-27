import { useEffect, useState } from "react";
import { ErrorBanner, ago } from "../../components/ui";
import { Icon, IconTile } from "../../components/Icon";
import { api } from "../../lib/api";
import { boardName, send } from "../Cluster/cluster";
import type { ClusterState, Job, Result, Section, Task } from "../Cluster/cluster";
import { SampleData } from "./Sample";
import { Stage } from "./Stage";
import { eventsOf, narrate } from "./story";
import type { StoryEvent } from "./story";
import "./Assistant.css";

export type StageInfo = { label: string; short: string; icon: string };
export type ScenarioInfo = { id: string; audience: string; icon: string; title: string; prompt: string; data: { label: string; items: string[] }; hasSample?: boolean; stages: StageInfo[] };

// The Assistant, one focus at a time: ask (an empty page with the prompt),
// watch (the boards splitting the job), read (the report).
// shown is the job this page follows. App keeps it, so it is still there after a visit to another page.
export function AssistantPage({ cluster, failed, reload, serverNow, shown, setShown }: {
  cluster: ClusterState | null;
  failed: boolean;
  reload: () => Promise<void>;
  serverNow: () => number;
  shown: string | null;
  setShown: (id: string | null) => void;
}) {
  const [scenarios, setScenarios] = useState<ScenarioInfo[]>([]);
  const [selected, setSelected] = useState("student");
  const [prompt, setPrompt] = useState("");
  const [pace, setPace] = useState("normal");
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const now = useClock(serverNow);

  useEffect(() => {
    api<{ scenarios: ScenarioInfo[] }>("/api/assistant/scenarios").then(({ scenarios }) => {
      setScenarios(scenarios);
      // The first scenario is picked to start with, its prompt in the box.
      if (scenarios[0]) setSelected(scenarios[0].id);
      setPrompt((current) => current || scenarios[0]?.prompt || "");
    }, (cause: Error) => setError(cause.message));
  }, []);

  const plans = cluster?.jobs.filter((job) => job.plan) ?? [];
  const running = plans.find((job) => job.doneAt === null) ?? null;
  const job = running ?? plans.find((entry) => entry.id === shown) ?? null;
  // A running job is followed through to its report, even one this page did not start.
  useEffect(() => {
    if (running) setShown(running.id);
  }, [running?.id, setShown]);
  const stale = failed ? (cluster ? "The cluster is not reachable. Showing the last received state." : "The cluster is not reachable. Start it with ./scripts/start-cluster.sh.") : null;
  const banner = error ?? stale;
  const scenario = scenarios.find((entry) => entry.id === (job?.plan!.scenario ?? selected));

  function pick(id: string) {
    setSelected(id);
    setPrompt(scenarios.find((entry) => entry.id === id)?.prompt ?? "");
  }

  // One job per click: Run stays off until the server answers.
  async function run() {
    if (starting) return;
    setStarting(true);
    setError(null);
    try {
      const { job } = await api<{ job: Job }>("/api/assistant/run", { scenario: selected, prompt, pace });
      setShown(job.id);
      await reload();
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setStarting(false);
    }
  }

  async function act(path: string, body?: unknown) {
    setError(await send(path, body));
    void reload();
  }

  if (!job) {
    return (
      <Ask
        scenarios={scenarios}
        selected={selected}
        prompt={prompt}
        pace={pace}
        error={banner}
        canRun={Boolean(cluster?.orchestrator && scenarios.length) && !starting}
        onPick={pick}
        onPrompt={setPrompt}
        onPace={setPace}
        onRun={() => void run()}
      />
    );
  }

  const tasks = cluster ? cluster.tasks.filter((task) => task.job === job.id) : [];
  const events = cluster ? eventsOf(job, tasks, cluster) : [];

  return (
    <div className="assistant">
      {banner && <ErrorBanner message={banner} />}
      <RunHeader job={job} scenario={scenario} onStop={() => void act("/api/assistant/stop", { job: job.id })} onAgain={() => setShown(null)} />
      {job.doneAt === null || !job.plan!.result ? (
        <Watching job={job} tasks={tasks} cluster={cluster} events={events} now={now} offset={serverNow() - Date.now()} act={(path) => void act(path)} />
      ) : (
        <Report job={job} tasks={tasks} events={events} offset={serverNow() - Date.now()} />
      )}
    </div>
  );
}

function Ask({ scenarios, selected, prompt, pace, error, canRun, onPick, onPrompt, onPace, onRun }: {
  scenarios: ScenarioInfo[];
  selected: string;
  prompt: string;
  pace: string;
  error: string | null;
  canRun: boolean;
  onPick: (id: string) => void;
  onPrompt: (prompt: string) => void;
  onPace: (pace: string) => void;
  onRun: () => void;
}) {
  const [browsing, setBrowsing] = useState(false);
  const scenario = scenarios.find((entry) => entry.id === selected);
  return (
    <div className="ask">
      <div className="ask-hero">
        <h1>What should your boards do?</h1>
        <p className="lede">Describe a job. One board splits it up, the others work on the pieces at the same time.</p>
      </div>
      {error && <ErrorBanner message={error} />}
      <div className="prompt-card">
        <label className="sr-only" htmlFor="prompt">Job</label>
        <textarea id="prompt" value={prompt} rows={3} onChange={(event) => onPrompt(event.target.value)} />
        <div className="prompt-foot">
          {scenario && (
            <span className="prompt-data" title={scenario.data.items.join("\n")}>
              <Icon name="info" size={14} />
              {scenario.data.label}
              {scenario.hasSample && (
                <button className="text-button" type="button" onClick={() => setBrowsing(true)}>
                  Open the demo inbox
                </button>
              )}
            </span>
          )}
          {browsing && scenario && <SampleData scenario={scenario.id} title={`${scenario.audience}: demo data`} onClose={() => setBrowsing(false)} />}
          <label className="pace">
            <span>Speed</span>
            <select value={pace} onChange={(event) => onPace(event.target.value)}>
              <option value="normal">Normal</option>
              <option value="slow">Slow</option>
              <option value="fast">Fast</option>
            </select>
          </label>
          <button className="button primary run-button" type="button" disabled={!canRun} onClick={onRun}>
            <Icon name="play" size={14} />
            Run
          </button>
        </div>
      </div>
      <div className="scenario-grid" role="group" aria-label="Example jobs">
        {scenarios.map((entry) => (
          <button key={entry.id} type="button" className="scenario-card" aria-pressed={entry.id === selected} onClick={() => onPick(entry.id)}>
            <IconTile name={entry.icon} size={16} />
            <span className="scenario-text">
              <strong>{entry.audience}</strong>
              <span>{entry.title}</span>
            </span>
            <DataBadge scenario={entry} />
          </button>
        ))}
      </div>
    </div>
  );
}

// Says what a job runs on: canned demo data, or the model live.
function DataBadge({ scenario }: { scenario: ScenarioInfo }) {
  return /^Live/.test(scenario.data.label) ? <span className="badge is-ok">Live AI</span> : <span className="badge is-sample">Demo data</span>;
}

function RunHeader({ job, scenario, onStop, onAgain }: { job: Job; scenario?: ScenarioInfo; onStop: () => void; onAgain: () => void }) {
  const done = job.doneAt !== null;
  return (
    <header className="run-header">
      <div className="run-summary" title={job.plan!.prompt}>
        {scenario && <IconTile name={scenario.icon} size={16} />}
        <div>
          <strong>{scenario?.title ?? job.name}</strong>
          <span>“{job.plan!.prompt}”</span>
        </div>
      </div>
      {scenario && <DataBadge scenario={scenario} />}
      {done ? (
        <button className="button primary" type="button" onClick={onAgain}>
          Run another job
        </button>
      ) : (
        <button className="button" type="button" onClick={onStop}>
          <Icon name="stop" size={14} />
          Stop
        </button>
      )}
    </header>
  );
}

// The plan's phases as icons and a word or two, with the current one lit.
function Stepper({ stages, current }: { stages: StageInfo[]; current: number }) {
  return (
    <ol className="stepper" aria-label="Plan">
      {stages.map((stage, index) => (
        <li key={stage.label} className={index < current ? "is-done" : index === current ? "is-now" : ""} aria-current={index === current ? "step" : undefined} title={stage.label}>
          <span className="step-icon">{index < current ? <Icon name="check" size={14} /> : <Icon name={stage.icon} size={14} />}</span>
          <span>{stage.short}</span>
        </li>
      ))}
    </ol>
  );
}

function Watching({ job, tasks, cluster, events, now, offset, act }: { job: Job; tasks: Task[]; cluster: ClusterState | null; events: StoryEvent[]; now: number; offset: number; act: (path: string) => void }) {
  const [log, setLog] = useState(false);
  if (!cluster) return null;
  const plan = job.plan!;
  const failure = () => {
    const working = cluster.nodes.filter((node) => node.up && node.id !== cluster.orchestrator && tasks.some((task) => task.status === "claimed" && task.worker === node.id));
    const pool = working.length ? working : cluster.nodes.filter((node) => node.up && node.id !== cluster.orchestrator);
    const victim = pool[Math.floor(Math.random() * pool.length)];
    if (victim) act(`/api/cluster/nodes/${victim.id}/kill`);
  };

  return (
    <>
      <Stepper stages={plan.stages} current={job.doneAt !== null ? plan.stages.length : plan.stage} />
      <section className="panel stage-card" aria-label="Cluster">
        <header className="stage-head">
          <p className="narration" aria-live="polite">{narrate(job, tasks, cluster, events, now)}</p>
          {/* Real boards fail for real: someone pulls a plug. */}
          {job.doneAt === null && !cluster.boards && (
            <button className="button small" type="button" onClick={failure} title="Kill a random working board and watch its work move">
              <Icon name="bolt" size={14} />
              Simulate a failure
            </button>
          )}
        </header>
        <Stage job={job} tasks={tasks} cluster={cluster} events={events} now={now} act={act} />
        <div className="log">
          <button className="text-button" type="button" aria-expanded={log} onClick={() => setLog(!log)}>
            {log ? "Hide log" : `Show log (${events.length})`}
          </button>
          {log && <Log events={events} offset={offset} />}
        </div>
      </section>
    </>
  );
}

function Log({ events, offset }: { events: StoryEvent[]; offset: number }) {
  return (
    <ol className="log-rows" aria-label="Log">
      {events.map((event) => (
        <li key={event.key} title={event.task?.input}>
          <span className="avatar">{event.board ? boardName(event.board).replace("Board ", "") : <Icon name="crown" size={11} />}</span>
          <span className="log-text">{event.text}</span>
          <time className="muted">{ago(Date.now() - (event.at - offset))}</time>
        </li>
      ))}
    </ol>
  );
}

function Report({ job, tasks, events, offset }: { job: Job; tasks: Task[]; events: StoryEvent[]; offset: number }) {
  const result = job.plan!.result as Result;
  const [tab, setTab] = useState(0);
  const [how, setHow] = useState(false);
  const section = result.sections[Math.min(tab, result.sections.length - 1)];

  return (
    <div className="report">
      <p className="headline">{result.headline}</p>
      <ul className="tiles" aria-label="Summary">
        {result.stats.map((stat) => (
          <li key={stat.label} className="tile">
            <strong>{stat.value}</strong>
            <span>{stat.label}</span>
          </li>
        ))}
        <li className="tile">
          <strong>{((job.doneAt! - job.queuedAt) / 1000).toFixed(0)} s</strong>
          <span>on {job.nodes} boards</span>
        </li>
      </ul>

      <section className="panel">
        <div className="tabs" role="tablist" aria-label="Result">
          {result.sections.map((entry, index) => (
            <button key={entry.title} type="button" role="tab" aria-selected={index === tab} className="tab" onClick={() => setTab(index)}>
              {entry.title}
            </button>
          ))}
        </div>
        <div className="tab-body" role="tabpanel">
          <SectionView section={section} />
        </div>
      </section>

      <div className="how">
        <button className="text-button" type="button" aria-expanded={how} onClick={() => setHow(!how)}>
          <Icon name="chevron" size={14} className={how ? "is-open" : ""} />
          See how the boards split it
        </button>
        {how && <Breakdown job={job} tasks={tasks} events={events} offset={offset} />}
      </div>
    </div>
  );
}

function SectionView({ section }: { section: Section }) {
  switch (section.kind) {
    case "table":
      return (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>{section.columns.map((column) => <th key={column}>{column}</th>)}</tr>
            </thead>
            <tbody>
              {section.rows.map((row, index) => <tr key={index}>{row.map((cell, at) => <td key={at}>{cell}</td>)}</tr>)}
            </tbody>
          </table>
        </div>
      );
    case "list":
      return <ul className="result-list">{section.items.map((item) => <li key={item}>{item}</li>)}</ul>;
    case "text":
      return <p className="result-text">{section.body}</p>;
    case "cards":
      return (
        <div className="brief-grid">
          {section.cards.map((card, index) => (
            <article className="brief" key={`${card.title}-${index}`}>
              <h3>{card.title}</h3>
              <p className="muted">{card.subtitle}</p>
              {card.lines.length > 1 ? <ul>{card.lines.map((line) => <li key={line}>{line}</li>)}</ul> : <p>{card.lines[0]}</p>}
            </article>
          ))}
        </div>
      );
  }
}

// Each phase, and which board did which piece, including any handovers.
function Breakdown({ job, tasks, events, offset }: { job: Job; tasks: Task[]; events: StoryEvent[]; offset: number }) {
  const [log, setLog] = useState(false);
  return (
    <div className="breakdown">
      {job.plan!.stages.map((stage, index) => {
        const steps = tasks.filter((task) => task.stage === index);
        if (!steps.length) return null;
        return (
          <div className="breakdown-stage" key={stage.label}>
            <div className="breakdown-title">
              <IconTile name={stage.icon} size={14} />
              <strong>{stage.short}</strong>
              <span className="muted">{steps.length} {steps.length === 1 ? "piece" : "pieces"}</span>
            </div>
            <ul>
              {steps.map((task) => {
                const run = task.runs.at(-1);
                return (
                  <li key={task.id} title={task.input}>
                    <Icon name={task.icon ?? "doc"} size={14} />
                    <span>{task.label}</span>
                    <span className="muted">
                      {task.lostBy.map((id) => `${boardName(id)} ✕ → `).join("")}
                      {run ? (task.role === "orchestrator" ? `${boardName(run.worker)} (orchestrator)` : boardName(run.worker)) : "—"}
                    </span>
                    <span className="breakdown-result">{task.output?.short}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
      <button className="text-button" type="button" aria-expanded={log} onClick={() => setLog(!log)}>
        {log ? "Hide log" : `Show log (${events.length})`}
      </button>
      {log && <Log events={events} offset={offset} />}
    </div>
  );
}

// Re-renders a few times a second so chips fly and the narration keeps up.
function useClock(serverNow: () => number) {
  const [now, setNow] = useState(serverNow);
  useEffect(() => {
    const timer = setInterval(() => setNow(serverNow()), 200);
    return () => clearInterval(timer);
  }, [serverNow]);
  return now;
}
