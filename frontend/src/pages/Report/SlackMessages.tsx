import { useCallback, useEffect, useState } from "react";
import { SlackLogo } from "../../components/SlackLogo/SlackLogo";
import "./SlackMessages.css";

type SlackMessage = {
  id: string;
  kind: "mention" | "dm";
  from: string;
  where: string;
  text: string;
  sentAt: string;
  url: string;
};

type State =
  | { status: "hidden" }
  | { status: "invite" }
  | { status: "loading" }
  | { status: "error"; error: string }
  | { status: "ready"; messages: SlackMessage[]; loadedAt: number };

const tones = ["blue", "green", "amber", "rose"];

function toneFor(name: string) {
  // FNV-1a, using the high bits: the low bits barely change between names.
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return tones[(hash >>> 16) % tones.length];
}

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function ago(iso: string, now: number) {
  const minutes = Math.round((now - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)}h`;
  return new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" });
}

// Highlight "@you" so it is obvious why a message landed here.
function MessageText({ text }: { text: string }) {
  return (
    <p className="slack-text">
      {text.split(/(@you\b)/).map((part, index) => (part === "@you" ? <mark key={index}>@you</mark> : part))}
    </p>
  );
}

function MessageRow({ message, now }: { message: SlackMessage; now: number }) {
  return (
    <li>
      <a className={`slack-row is-${message.kind}`} href={message.url} target="_blank" rel="noreferrer">
        <span className={`slack-avatar tone-${toneFor(message.from)}`} aria-hidden="true">{initials(message.from)}</span>
        <span className="slack-body">
          <span className="slack-meta">
            <span className="slack-from">{message.from}</span>
            {message.kind === "mention" && <span className="slack-where">{message.where}</span>}
            <span className="slack-right">
              <time dateTime={message.sentAt} title={new Date(message.sentAt).toLocaleString()}>{ago(message.sentAt, now)}</time>
              <span className="slack-open">Open in Slack <span aria-hidden="true">↗</span></span>
            </span>
          </span>
          <MessageText text={message.text} />
        </span>
      </a>
    </li>
  );
}

function Group({ title, hint, messages, now }: { title: string; hint: string; messages: SlackMessage[]; now: number }) {
  if (messages.length === 0) return null;
  return (
    <section className="slack-group">
      <h3 className="slack-group-title">
        {title}
        <span>{messages.length}</span>
        <small>{hint}</small>
      </h3>
      <ul className="slack-list">
        {messages.map((message) => <MessageRow key={message.id} message={message} now={now} />)}
      </ul>
    </section>
  );
}

export function SlackMessages() {
  const [state, setState] = useState<State>({ status: "loading" });
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      const connectionResponse = await fetch("/api/slack/connection", { cache: "no-store" });
      if (!connectionResponse.ok) return setState({ status: "hidden" });
      const { slack } = await connectionResponse.json();
      if (!slack?.connected) return setState({ status: slack?.configured ? "invite" : "hidden" });
      if (!slack.enabled) return setState({ status: "hidden" });

      const response = await fetch("/api/slack/messages", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not load Slack messages.");
      setState({ status: "ready", messages: result.messages, loadedAt: Date.now() });
    } catch (cause) {
      setState({ status: "error", error: cause instanceof Error ? cause.message : "Could not load Slack messages." });
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  if (state.status === "hidden") return null;

  if (state.status === "invite") {
    return (
      <div className="report-panel slack-panel slack-invite">
        <SlackLogo size={20} />
        <p>Connect Slack to see mentions and DMs that are waiting on you.</p>
        <a href="/settings">Connect Slack</a>
      </div>
    );
  }

  const dms = state.status === "ready" ? state.messages.filter((message) => message.kind === "dm") : [];
  const mentions = state.status === "ready" ? state.messages.filter((message) => message.kind === "mention") : [];

  return (
    <div className="report-panel slack-panel" aria-busy={state.status === "loading"}>
      <div className="report-panel-header">
        <div className="report-title">
          <SlackLogo />
          <h2>Slack</h2>
          {state.status === "ready" && <span className="report-count">{state.messages.length ? `${state.messages.length} waiting on you` : "all caught up"}</span>}
        </div>
        <div className="slack-actions">
          {state.status === "ready" && <span className="slack-updated">updated {ago(new Date(state.loadedAt).toISOString(), now)}</span>}
          <button className="report-refresh" type="button" onClick={() => void load()} disabled={state.status === "loading"}>
            {state.status === "loading" ? "Loading…" : "Refresh"}
          </button>
        </div>
      </div>

      {state.status === "loading" && (
        <ul className="slack-list slack-skeleton" aria-label="Loading Slack messages">
          {[0, 1, 2].map((row) => (
            <li key={row} className="slack-row">
              <span className="slack-avatar" />
              <span className="slack-body"><span className="bar short" /><span className="bar" /></span>
            </li>
          ))}
        </ul>
      )}

      {state.status === "error" && (
        <div className="slack-state" role="alert">
          <p>{state.error}</p>
          <div>
            <button type="button" onClick={() => void load()}>Try again</button>
            <a href="/settings">Open Settings</a>
          </div>
        </div>
      )}

      {state.status === "ready" && state.messages.length === 0 && (
        <div className="slack-state is-clear">
          <span className="slack-check" aria-hidden="true">✓</span>
          <p>Nothing waiting on you</p>
          <small>No mentions or unanswered DMs in the last 24 hours</small>
        </div>
      )}

      <Group title="Needs a reply" hint="DMs where they spoke last" messages={dms} now={now} />
      <Group title="Mentions" hint="from the last 24 hours" messages={mentions} now={now} />
    </div>
  );
}
