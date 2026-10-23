import { useState } from "react";
import { Icon } from "../../components/Icon";
import { RelativeTime, SkeletonRows, SourceLogo } from "../../components/ui";
import { appPath } from "../../lib/urls";
import { JiraEditor } from "./JiraEditor";
import { rank, score } from "./rank";
import type { Item } from "./rank";
import { titles } from "./sources";
import type { SourceName } from "./sources";
import "./Today.css";

const DONE_KEY = "continuum-done";

// What was marked done, kept in this browser. An item counts as done only
// until it changes again, so a new reply brings it back.
export function useDone() {
  const [done, setDone] = useState<string[]>(() => {
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(DONE_KEY) ?? "[]");
      return Array.isArray(saved) ? saved.filter((key) => typeof key === "string") : [];
    } catch {
      return [];
    }
  });
  const update = (next: string[]) => {
    // ponytail: keeps the newest 300; old items that no longer come back are not worth more
    const kept = next.slice(-300);
    setDone(kept);
    try {
      localStorage.setItem(DONE_KEY, JSON.stringify(kept));
    } catch {
      // Done still works for this visit.
    }
  };
  const id = (item: Item) => `${item.key}@${item.at}`;
  return {
    isDone: (item: Item) => done.includes(id(item)),
    markDone: (item: Item) => update([...done, id(item)]),
    undo: (item: Item) => update(done.filter((key) => key !== id(item))),
  };
}

// Someone is waiting on you: a direct message, pull request or unread email.
export const isWaiting = (item: Item) => score(item) >= 4;

type Sort = "rank" | "source" | "updated";
const sorts: Array<{ value: Sort; label: string }> = [
  { value: "rank", label: "#" },
  { value: "source", label: "Source" },
  { value: "updated", label: "Updated" },
];

// Today's work as a table: ranked, filterable by source, sortable by rank,
// source or time. With nothing connected it shows sample rows, marked as such.
export function TasksPanel({ items, cleared, loading, sample, checked, onDone, onUndo, onSaved, onOutlookAction, onOutlookReply }: {
  items: Item[];
  cleared: Item[];
  loading: boolean;
  sample: boolean;
  // Every source that is on loaded, so an empty list really is empty.
  checked: boolean;
  onDone: (item: Item) => void;
  onUndo: (item: Item) => void;
  onSaved: () => Promise<void>;
  onOutlookAction: (action: "read" | "delete", messageId: string) => Promise<void>;
  onOutlookReply: (messageId: string, comment: string) => Promise<void>;
}) {
  const [filter, setFilter] = useState<SourceName | "all">("all");
  const [sort, setSort] = useState<Sort>("rank");
  const shown = sample ? rank(sampleItems()) : items;
  const ranked = shown.map((item, index) => ({ item, rank: index + 1 }));
  // Rows the filter leaves out stay mounted, hidden, so an open Jira edit keeps its draft.
  const shows = (item: Item) => filter === "all" || item.source === filter;
  const rows = ranked.sort((a, b) => (sort === "updated" ? b.item.at - a.item.at : sort === "source" ? titles[a.item.source].localeCompare(titles[b.item.source]) || a.rank - b.rank : a.rank - b.rank));
  const empty = !rows.some(({ item }) => shows(item));
  const count = (name: SourceName) => shown.filter((item) => item.source === name).length;

  return (
    <section className="panel tasks" id="tasks" aria-labelledby="tasks-title">
      <header className="panel-head">
        <h2 id="tasks-title">Today's tasks</h2>
        {sample && <span className="badge is-sample">Sample data</span>}
        <div className="chips" role="group" aria-label="Filter by source">
          <button className="chip-button" type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")}>
            All <span className="count">{shown.length}</span>
          </button>
          {(["slack", "jira", "github", "outlook"] as SourceName[]).map((name) => (
            <button className="chip-button" type="button" key={name} aria-pressed={filter === name} onClick={() => setFilter(name)}>
              <SourceLogo name={name} />
              {titles[name]} <span className="count">{count(name)}</span>
            </button>
          ))}
        </div>
      </header>
      {sample && (
        <p className="panel-note">
          These rows are examples. <a href={appPath("connections")} data-page="connections">Connect Slack, Jira, GitHub or Outlook</a> to see your own.
        </p>
      )}

      {loading ? (
        <SkeletonRows count={5} />
      ) : (
        <>
          {empty && <p className="panel-empty">{items.length ? "Nothing from this source." : checked ? "Nothing waiting. You are all caught up." : "Nothing to show, but a source could not be loaded."}</p>}
          {rows.length > 0 && (
            <table className="table tasks-table" aria-label={sample ? "Sample tasks" : "Today"} hidden={empty}>
              <thead>
                <tr>
                  <th className="col-done"><span className="sr-only">Done</span></th>
                  {sorts.slice(0, 2).map((column) => <SortHeader key={column.value} column={column} sort={sort} setSort={setSort} />)}
                  <th>Item</th>
                  <th>From</th>
                  <th>Status</th>
                  <SortHeader column={sorts[2]} sort={sort} setSort={setSort} />
                  <th className="col-action"><span className="sr-only">Action</span></th>
                </tr>
              </thead>
              <tbody>
                {rows.map(({ item, rank }) => <Row key={item.key} item={item} rank={rank} sample={sample} hidden={!shows(item)} onDone={() => onDone(item)} onSaved={onSaved} onOutlookAction={onOutlookAction} onOutlookReply={onOutlookReply} />)}
              </tbody>
            </table>
          )}
        </>
      )}

      {cleared.length > 0 && (
        <details className="done-list">
          <summary>
            Done today <span className="count">{cleared.length}</span>
          </summary>
          <ul>
            {cleared.map((item) => (
              <li key={item.key}>
                <SourceLogo name={item.source} />
                <span className="what">{textOf(item)}</span>
                <button className="button small" type="button" onClick={() => onUndo(item)}>Undo</button>
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function SortHeader({ column, sort, setSort }: { column: { value: Sort; label: string }; sort: Sort; setSort: (sort: Sort) => void }) {
  const on = sort === column.value;
  return (
    <th className={`col-${column.value}`} aria-sort={on ? (column.value === "updated" ? "descending" : "ascending") : undefined}>
      <button className="sort-button" type="button" onClick={() => setSort(column.value)} aria-label={`Sort by ${column.value === "rank" ? "rank" : column.label.toLowerCase()}`}>
        {column.label}
        <span aria-hidden="true">{on ? (column.value === "updated" ? "↓" : "↑") : ""}</span>
      </button>
    </th>
  );
}

export function textOf(item: Item) {
  switch (item.source) {
    case "slack": return item.data.text;
    case "jira": return item.data.summary;
    case "github": return item.data.title;
    case "outlook": return item.data.subject;
  }
}

function Row({ item, rank, sample, hidden, onDone, onSaved, onOutlookAction, onOutlookReply }: { item: Item; rank: number; sample: boolean; hidden: boolean; onDone: () => void; onSaved: () => Promise<void>; onOutlookAction: (action: "read" | "delete", messageId: string) => Promise<void>; onOutlookReply: (messageId: string, comment: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [replying, setReplying] = useState(false);
  const [replyDraft, setReplyDraft] = useState("");
  const [replyBusy, setReplyBusy] = useState(false);
  const [replyStatus, setReplyStatus] = useState({ text: "", isError: false });
  const [outlookBusy, setOutlookBusy] = useState(false);
  const [outlookError, setOutlookError] = useState("");
  const editorId = `edit-${item.key}`;
  const link = sample ? undefined : item.data.url;

  async function actOnOutlook(action: "read" | "delete") {
    if (item.source !== "outlook") return;
    if (action === "delete" && !window.confirm("Delete this email? You can find it in Outlook's Deleted Items.")) return;
    setOutlookBusy(true);
    setOutlookError("");
    try {
      await onOutlookAction(action, item.data.id);
    } catch (cause) {
      setOutlookError((cause as Error).message);
    } finally {
      setOutlookBusy(false);
    }
  }

  async function sendOutlookReply() {
    if (item.source !== "outlook" || !replyDraft.trim()) return;
    setReplyBusy(true);
    setReplyStatus({ text: "", isError: false });
    try {
      await onOutlookReply(item.data.id, replyDraft);
      setReplyDraft("");
      setReplying(false);
      setReplyStatus({ text: "Reply sent.", isError: false });
    } catch (cause) {
      setReplyStatus({ text: (cause as Error).message, isError: true });
    } finally {
      setReplyBusy(false);
    }
  }

  return (
    <>
      <tr className={`task-row is-${item.source}${sample ? " is-sample" : ""}${isWaiting(item) ? " is-waiting" : ""}`} aria-label={textOf(item)} hidden={hidden}>
        <td className="col-done">
          {!sample && (
            <button className="done-button" type="button" aria-label="Done" title="Mark done" onClick={onDone}>
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 8.5 2.5 2.5L12 5.5" /></svg>
            </button>
          )}
        </td>
        <td className="col-rank num">{rank}</td>
        <td className="col-source">
          <span className="source-cell"><SourceLogo name={item.source} />{titles[item.source]}</span>
        </td>
        <td className="col-item">
          {item.source === "jira" && (link ? <a className="jira-key" href={link} target="_blank" rel="noreferrer">{item.data.key}</a> : <span className="jira-key">{item.data.key}</span>)}
          {item.source === "github" && <span className="item-number">#{item.data.number}</span>}
          <span className="what">{item.source === "slack" ? withMentions(item.data.text) : textOf(item)}</span>
        </td>
        <td className="col-from">{fromOf(item)}</td>
        <td className="col-status"><Status item={item} /></td>
        <td className="col-updated num">{item.at > 0 ? <RelativeTime value={item.at} /> : "—"}</td>
        <td className="col-action">
          {sample ? null : item.source === "jira" ? (
            <button className={editing ? "button small is-on" : "button small"} type="button" aria-expanded={editing} aria-controls={editorId} onClick={() => setEditing(!editing)}>
              Edit
            </button>
          ) : item.source === "outlook" ? (
            <div className="outlook-row-actions">
              <a className="button small" href={link} target="_blank" rel="noreferrer">Open</a>
              <button className={replying ? "button small is-on" : "button small"} type="button" aria-expanded={replying} aria-controls={`${editorId}-reply`} disabled={outlookBusy || replyBusy} onClick={() => { setReplying(!replying); setReplyStatus({ text: "", isError: false }); }}>Reply</button>
              <button className="button small outlook-icon-button" type="button" aria-label="Mark as read" title="Mark as read" disabled={outlookBusy} onClick={() => void actOnOutlook("read")}>
                <Icon name="check" size={16} />
              </button>
              <button className="button small outlook-icon-button is-delete" type="button" aria-label="Delete email" title="Delete email" disabled={outlookBusy} onClick={() => void actOnOutlook("delete")}>
                <Icon name="trash" size={15} />
              </button>
              {outlookError && <span className="outlook-action-error" role="alert">{outlookError}</span>}
              {replyStatus.text && <span className={replyStatus.isError ? "outlook-action-error" : "outlook-action-status"} role={replyStatus.isError ? "alert" : "status"}>{replyStatus.text}</span>}
            </div>
          ) : (
            <a
              className="button small"
              href={link}
              target="_blank"
              rel="noreferrer"
              aria-label={item.source === "outlook" ? "Open in Outlook" : undefined}
              title={item.source === "outlook" ? "Open in Outlook" : undefined}
            >
              {item.source === "slack" ? "Reply" : "Open"}
            </a>
          )}
        </td>
      </tr>
      {item.source === "jira" && editing && (
        <tr className="editor-row" hidden={hidden}>
          <td colSpan={8}>
            <JiraEditor issue={item.data} id={editorId} onSaved={onSaved} onClose={() => setEditing(false)} />
          </td>
        </tr>
      )}
      {item.source === "outlook" && replying && (
        <tr className="editor-row outlook-reply-row" hidden={hidden}>
          <td colSpan={8}>
            <div className="jira-details outlook-reply-editor" id={`${editorId}-reply`}>
              <label className="outlook-reply-label">
                Reply to {item.data.from}
                <textarea autoFocus rows={4} value={replyDraft} onChange={(event) => setReplyDraft(event.target.value)} placeholder="Write your reply…" disabled={replyBusy} />
              </label>
              <div className="jira-actions">
                <button className="button small primary" type="button" disabled={replyBusy || !replyDraft.trim()} onClick={() => void sendOutlookReply()}>{replyBusy ? "Sending…" : "Send reply"}</button>
                <button className="button small quiet" type="button" disabled={replyBusy} onClick={() => setReplying(false)}>Cancel</button>
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function fromOf(item: Item) {
  switch (item.source) {
    case "slack":
      return item.data.from;
    case "jira":
      return item.data.reporter;
    case "github":
      return <span title={item.data.repository}>{item.data.repository.split("/").at(-1)}</span>;
    case "outlook":
      return item.data.from;
  }
}

function Status({ item }: { item: Item }) {
  switch (item.source) {
    case "slack":
      return <span className="badge">{item.data.kind === "dm" ? "Direct message" : `Mention in ${item.data.where}`}</span>;
    case "jira":
      return <span className={/progress|review/i.test(item.data.status) ? "badge is-ok" : "badge"}>{item.data.status}</span>;
    case "github":
      return <span className="badge">{item.data.kind === "pull_request" ? "Pull request" : "Issue"}</span>;
    case "outlook":
      return <span className="badge">Unread email</span>;
  }
}

function withMentions(text: string) {
  return text.split(/(@you\b)/).map((part, index) => (part === "@you" ? <mark key={index}>@you</mark> : part));
}

const sampleAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

// Illustrative only: these are never written anywhere, and never counted as real work.
function sampleItems(): Item[] {
  const at = (minutes: number) => Date.now() - minutes * 60_000;
  return [
    {
      key: "sample:slack", source: "slack", at: at(3),
      data: { id: "sample-slack", kind: "dm", from: "Priya Raman", where: "Direct message", text: "Can you look over the demo script before standup?", sentAt: sampleAgo(3), url: "" },
    },
    {
      key: "sample:jira", source: "jira", at: at(41),
      data: { key: "QT1S-42", summary: "Wire the failover test into CI", status: "In Progress", issueType: "Task", updated: sampleAgo(41), url: "", description: "", sprints: ["Sprint 5"], labels: [], storyPointEstimate: 3, reporter: "Alex Kim" },
    },
    {
      key: "sample:github", source: "github", at: at(95),
      data: { id: "sample-github", kind: "pull_request", repository: "Capstone-Qualcomm/snapdragons", number: 15, title: "Today and Cluster redesign", state: "open", updatedAt: sampleAgo(95), url: "" },
    },
    {
      key: "sample:mention", source: "slack", at: at(12),
      data: { id: "sample-mention", kind: "mention", from: "Jordan Lee", where: "#dev", text: "@you the nightly build failed on the board image", sentAt: sampleAgo(12), url: "" },
    },
  ];
}
