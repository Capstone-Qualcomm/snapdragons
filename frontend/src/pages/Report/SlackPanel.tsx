import type { CSSProperties } from "react";
import type { SlackMessage, Source } from "./useSlackSource";
import { ago } from "./useSlackSource";

function SourceState({ source, empty }: { source: Source<unknown>; empty: string }) {
  const title = source.name === "jira" ? "Jira" : "Slack";
  if (source.status === "loading") return <p className="panel-state">Loading {title}…</p>;
  if (source.status === "unconfigured") return <p className="panel-state">{title} sign-in is not set up on this server yet.</p>;
  if (source.status === "disconnected") return <p className="panel-state">{title} is not connected. <a href={`/auth/${source.name}/start`}>Connect {title}</a></p>;
  if (source.status === "disabled") return <p className="panel-state">{title} is turned off for Report. <button type="button" onClick={() => void source.enable()}>Turn on</button></p>;
  if (source.status === "error") return <p className="panel-state is-error">{source.error} <button type="button" onClick={() => void source.reload()}>Retry</button></p>;
  if (source.items.length === 0) return <p className="panel-state">{empty}</p>;
  return null;
}

const stickers = ["#f2c7a8", "#cfdcae", "#f3dc9b", "#e3c3d6", "#bfdcd6"];

function sticker(name: string) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  hash >>>= 0;
  return { "--sticker": stickers[(hash >>> 8) % stickers.length], "--tilt": `${((hash % 7) - 3) * 1.2}deg` } as CSSProperties;
}

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function SlackRow({ message, now }: { message: SlackMessage; now: number }) {
  return (
    <li className={`work-row is-${message.kind}`}>
      <span className="avatar" aria-hidden="true" style={sticker(message.from)}>{initials(message.from)}</span>
      <div className="work-main">
        <div className="work-meta">
          <span className="work-title">{message.from}</span>
          <span className="work-sub">{message.where}</span>
          <time dateTime={message.sentAt} title={new Date(message.sentAt).toLocaleString()}>{ago(message.sentAt, now)}</time>
        </div>
        <p className="work-text">
          {message.text.split(/(@you\b)/).map((part, index) => (part === "@you" ? <mark key={index}>@you</mark> : part))}
        </p>
      </div>
      <a className="row-action" href={message.url} target="_blank" rel="noreferrer">Reply ↗</a>
    </li>
  );
}

export function SlackPanel({ source, now }: { source: Source<SlackMessage>; now: number }) {
  const dms = source.items.filter((message) => message.kind === "dm");
  const mentions = source.items.filter((message) => message.kind === "mention");
  const groups = [
    { title: "Needs a reply", hint: "they spoke last", items: dms, stamp: true },
    { title: "Mentions", hint: "last 24 hours", items: mentions, stamp: false },
  ];

  return (
    <section className="work-panel">
      <header className="work-head">
        <h2>Waiting on you</h2>
        <span className="work-count">{source.status === "ready" ? source.items.length : "–"}</span>
        <span className="work-source">Slack</span>
      </header>
      <SourceState source={source} empty="Nobody is waiting on you in Slack. Enjoy it." />
      {source.status === "ready" && groups.map((group) => group.items.length > 0 && (
        <div key={group.title}>
          <h3 className="work-group">{group.stamp ? <span className="stamp">{group.title} · {group.items.length}</span> : <>{group.title} <span>{group.items.length}</span></>} <small>{group.hint}</small></h3>
          <ul className="work-list">
            {group.items.map((message) => <SlackRow key={message.id} message={message} now={now} />)}
          </ul>
        </div>
      ))}
    </section>
  );
}