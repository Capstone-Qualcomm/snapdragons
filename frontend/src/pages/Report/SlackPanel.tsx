import type { CSSProperties } from "react";
import { Panel, RelativeTime, SourceLogo } from "../../components/ui";
import { SourceState } from "./SourceState";
import type { SlackMessage } from "./useSlackSource";
import type { Source } from "./useSource";

const avatarColors = ["#e9c3a6", "#cbd6a8", "#ecd497", "#dcc0cf", "#b9d3cc"];

// Each person keeps the same avatar color every time.
function avatarColor(name: string) {
  let hash = 2166136261;
  for (const char of name) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return { "--avatar": avatarColors[(hash >>> 8) % avatarColors.length] } as CSSProperties;
}

function initials(name: string) {
  const parts = name.replace(/[^\p{L}\s]/gu, " ").trim().split(/\s+/);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function SlackRow({ message }: { message: SlackMessage }) {
  return (
    <li className="item">
      <span className="avatar" aria-hidden="true" style={avatarColor(message.from)}>{initials(message.from)}</span>
      <div className="item-main">
        <p className="item-meta">
          <strong>{message.from}</strong>
          {message.kind === "mention" && <span>{message.where}</span>}
          <RelativeTime value={message.sentAt} />
        </p>
        <p className="item-text">
          {message.text.split(/(@you\b)/).map((part, index) => (part === "@you" ? <mark key={index}>@you</mark> : part))}
        </p>
      </div>
      <a className="button small" href={message.url} target="_blank" rel="noreferrer" aria-label={`Reply to ${message.from} in Slack`}>Reply</a>
    </li>
  );
}

export function SlackPanel({ source }: { source: Source<SlackMessage> }) {
  const groups = [
    { title: "Direct messages", items: source.items.filter((message) => message.kind === "dm") },
    { title: "Mentions", items: source.items.filter((message) => message.kind === "mention") },
  ];

  return (
    <Panel title="Slack" icon={<SourceLogo name="slack" />} count={source.status === "ready" ? source.items.length : null} id="report-slack">
      <SourceState source={source} empty="Nobody is waiting on you in Slack." />
      {source.status === "ready" && groups.map((group) => group.items.length > 0 && (
        <div key={group.title}>
          <h3 className="group-label">{group.title}</h3>
          <ul className="rows">
            {group.items.map((message) => <SlackRow key={message.id} message={message} />)}
          </ul>
        </div>
      ))}
    </Panel>
  );
}
