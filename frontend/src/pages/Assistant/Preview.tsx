import type { CSSProperties } from "react";
import { Icon } from "../../components/Icon";
import { boardName } from "../Cluster/cluster";
import type { Found, Task } from "../Cluster/cluster";

// A small live sketch of the work a board holds, drawn from the step's real
// input and what it found, and paced by its progress: a list being scanned row
// by row with matches tagged, a page being read and summed up, a week with open
// slots lighting up. A dead board's sketch stays where it stopped, dimmed.

const LIST_NAMES: Record<string, string> = { inbox: "Inbox", resume: "Resumes", invoice: "Invoices", chat: "Messages", items: "Items", search: "Results" };
const ROWS = 5;
const ROW_H = 17;

export function Preview({ task, progress, frozen = false }: { task: Task; progress: number; frozen?: boolean }) {
  const preview = task.preview;
  if (!preview) return null;
  const found: Found = task.found ?? task.output?.found ?? {};
  // A dead board's sketch shows where it stopped, even after another board finished the step.
  const done = task.status === "done" && !frozen;
  const className = `preview is-${preview.kind}${frozen ? " is-frozen" : ""}`;

  if (preview.kind === "list") {
    const total = preview.rows.length;
    const at = done ? total : Math.min(total - 1, Math.floor(progress * total));
    const first = Math.max(0, Math.min(at - 2, total - ROWS));
    const marks = new Map((found.marks ?? []).filter(([row]) => row < at || done).map(([row, tag]) => [row, tag]));
    // Links a board pulls out show once it has read past every row they came from.
    const chips = done || (found.marks ?? []).every(([row]) => row < at) ? (found.chips ?? []) : [];
    return (
      <div className={className} aria-hidden="true">
        <div className="preview-bar">
          <span>{LIST_NAMES[preview.look] ?? "Items"}</span>
          <span className="num">{Math.min(at, total)}/{total}</span>
        </div>
        <div className="list-window">
          <ol className="list-rows" style={{ transform: `translateY(${-first * ROW_H}px)` } as CSSProperties}>
            {preview.rows.map(([title, detail], row) => (
              <li key={row} className={`${row === at && !done ? "is-now" : row < at ? "is-read" : ""}${marks.has(row) ? " is-hit" : ""}`}>
                <span className="row-title">{title}</span>
                <span className="row-detail">{detail}</span>
                {marks.has(row) && <span className="row-tag">✓ {marks.get(row)}</span>}
              </li>
            ))}
          </ol>
        </div>
        {chips.length > 0 && (
          <div className="preview-chips">
            {chips.map((chip) => <span key={chip} className="link-chip"><Icon name="globe" size={10} />{chip}</span>)}
          </div>
        )}
      </div>
    );
  }

  if (preview.kind === "page") {
    const count = preview.pages.length;
    const position = done ? count - 0.001 : Math.min(count - 0.001, progress * count);
    const index = Math.floor(position);
    const local = position - index;
    const page = preview.pages[index];
    const read = Math.floor(local * (page.lines.length + 1));
    const summary = (found.pages ?? [])[index] ?? [];
    const summing = done || local > 0.6;
    return (
      <div className={`${className} look-${preview.look}`} aria-hidden="true">
        <div className="preview-bar">
          {preview.look === "browser" && <span className="lights"><i /><i /><i /></span>}
          <span className="url">{page.url}</span>
          {count > 1 && <span className="num">{index + 1}/{count}</span>}
        </div>
        <div className="sheet">
          {preview.look === "draft" && summary.length ? (
            // Text the board is writing, shown as it streams in, with a caret while it goes.
            <div className="page-draft">
              {summary.map((line, at) => <p key={at}>{line}</p>)}
              {!done && <i className="caret" />}
            </div>
          ) : summing && summary.length ? (
            <ul className="page-summary">
              {summary.map((line) => <li key={line}>✓ {line}</li>)}
            </ul>
          ) : (
            page.lines.slice(0, 6).map((line, at) => (
              <p key={at} className={at === read ? "is-now" : at < read ? "is-read" : ""}>{line}</p>
            ))
          )}
        </div>
      </div>
    );
  }

  // A week, 9 to 5: busy blocks in gray, open slots lighting up one by one.
  const open = 9 * 60;
  const span = 8 * 60;
  const slots = found.slots ?? [];
  const lit = done ? slots.length : Math.floor(progress * (slots.length + 1));
  const last = slots[lit - 1];
  const block = ([day, start, end]: [number, number, number]) => ({
    left: `${(day / preview.days.length) * 100}%`,
    width: `${100 / preview.days.length}%`,
    top: `${((Math.max(start, open) - open) / span) * 100}%`,
    height: `${((Math.min(end, open + span) - Math.max(start, open)) / span) * 100}%`,
  });
  return (
    <div className={className} aria-hidden="true">
      <div className="preview-bar">
        <span>Calendar</span>
        <span className="num">{last ? `${preview.days[last[0]]} ${clock(last[1])}` : `${lit}/${slots.length || "…"}`}</span>
      </div>
      <div className="week">
        <div className="week-days">{preview.days.map((day) => <span key={day}>{day}</span>)}</div>
        <div className="week-grid">
          {preview.busy.map((cell, index) => <i key={`b${index}`} className="busy" style={block(cell)} />)}
          {slots.slice(0, lit).map((cell, index) => <i key={`s${index}`} className={index === lit - 1 && !done ? "slot is-new" : "slot"} style={block(cell)} />)}
        </div>
      </div>
    </div>
  );
}

const clock = (minutes: number) => `${((Math.floor(minutes / 60) + 11) % 12) + 1}:${String(minutes % 60).padStart(2, "0")}`;

// The orchestrator's sketch: the pieces of the current phase, who has each, and
// what came back, so the splitting and the collecting can both be seen.
export function Dispatch({ tasks }: { tasks: Task[] }) {
  return (
    <ol className="dispatch" aria-label="Pieces">
      {tasks.map((task, index) => {
        const holder = task.status === "claimed" ? task.worker : task.status === "done" ? task.runs.at(-1)?.worker : task.assignee;
        return (
          <li key={task.id} className={`is-${task.status}${task.lostBy.length && task.status !== "done" ? " is-moved" : ""}`} style={{ animationDelay: `${index * 90}ms` } as CSSProperties} title={task.input}>
            <Icon name={task.icon ?? "doc"} size={12} />
            <span className="dispatch-label">{task.label}</span>
            <span className="dispatch-to">{holder ? `→ ${boardName(holder).replace("Board ", "B")}` : "waiting"}</span>
            {task.status === "done" ? (
              <span className="dispatch-back">✓ {task.output?.short}</span>
            ) : task.status === "claimed" ? (
              <span className="dispatch-bar"><i style={{ width: `${task.progress * 100}%` }} /></span>
            ) : task.lostBy.length ? (
              <span className="dispatch-lost">↺ from {boardName(task.lostBy.at(-1)!).replace("Board ", "B")}</span>
            ) : (
              <span className="dispatch-wait">queued</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
