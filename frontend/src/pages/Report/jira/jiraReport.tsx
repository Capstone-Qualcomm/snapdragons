import { useId, useState } from "react";
import { Panel, RelativeTime, SourceLogo } from "../../../components/ui";
import { SourceState } from "../SourceState";
import type { Source } from "../useSource";
import { getJiraTransitions, updateJiraIssue } from "./jiraService";
import type { JiraChanges, JiraIssue, JiraTransition } from "./jiraService";

type Draft = { description: string; storyPointEstimate: string; transitionId: string };
const storyPointOptions = ["1", "2", "3", "5", "8", "13", "21"];

function draftOf(issue: JiraIssue): Draft {
  return {
    description: issue.description,
    storyPointEstimate: issue.storyPointEstimate == null ? "" : String(issue.storyPointEstimate),
    transitionId: "",
  };
}

// Only fields the user actually changed are sent, so Jira is never asked to
// rewrite a value that stayed the same.
function changesBetween(before: Draft, after: Draft): JiraChanges {
  const changes: JiraChanges = {};
  if (after.description !== before.description) changes.description = after.description;
  if (after.storyPointEstimate !== before.storyPointEstimate) {
    changes.storyPointEstimate = after.storyPointEstimate === "" ? null : Number(after.storyPointEstimate);
  }
  if (after.transitionId) changes.transitionId = after.transitionId;
  return changes;
}

function JiraRow({ issue, onSaved }: { issue: JiraIssue; onSaved: () => Promise<void> }) {
  const detailsId = useId();
  const [open, setOpen] = useState(false);
  // A draft exists only while editing; reading the details can't change anything.
  const [draft, setDraft] = useState<Draft | null>(null);
  // The values when Edit was clicked, so a sync while editing doesn't turn
  // Jira's newer values into changes.
  const [base, setBase] = useState<Draft | null>(null);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  const changes = draft && base ? changesBetween(base, draft) : {};
  const changeCount = Object.keys(changes).length;
  const points = issue.storyPointEstimate == null ? "" : String(issue.storyPointEstimate);

  async function startEditing() {
    setBase(draftOf(issue));
    setDraft(draftOf(issue));
    setMessage({ text: "", isError: false });
    try {
      setTransitions(await getJiraTransitions(issue.key));
    } catch (cause) {
      setMessage({ text: (cause as Error).message, isError: true });
    }
  }

  async function save() {
    setSaving(true);
    setMessage({ text: "", isError: false });
    try {
      await updateJiraIssue(issue.key, changes);
      setDraft(null);
      setMessage({ text: "Saved to Jira.", isError: false });
      await onSaved();
    } catch (cause) {
      setMessage({ text: (cause as Error).message, isError: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <li className="jira-issue">
      <div className="item">
        <div className="item-main">
          <p className="item-meta">
            <a className="jira-key" href={issue.url} target="_blank" rel="noreferrer">{issue.key}</a>
            <span>{issue.issueType}</span>
            <span>{issue.status}</span>
            {issue.updated && <RelativeTime value={issue.updated} />}
          </p>
          <p className="item-text">{issue.summary}</p>
        </div>
        <button
          className={open ? "header-button jira-toggle is-open" : "header-button jira-toggle"}
          type="button"
          aria-label={`${open ? "Hide" : "Show"} details for ${issue.key}`}
          aria-expanded={open}
          aria-controls={detailsId}
          onClick={() => setOpen(!open)}
        >
          <svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4.5 6 3.5 3.5L11.5 6" /></svg>
        </button>
      </div>

      <div className="jira-details" id={detailsId} hidden={!open}>
        {draft ? (
          <div className="jira-fields">
            <label className="jira-wide">
              Description
              <textarea value={draft.description} rows={4} onChange={(event) => setDraft({ ...draft, description: event.target.value })} />
            </label>
            <label>
              Story points
              <select value={draft.storyPointEstimate} onChange={(event) => setDraft({ ...draft, storyPointEstimate: event.target.value })}>
                <option value="">Not set</option>
                {points && !storyPointOptions.includes(points) && <option value={points}>{points}</option>}
                {storyPointOptions.map((option) => <option key={option} value={option}>{option}</option>)}
              </select>
            </label>
            <label>
              Status
              <select value={draft.transitionId} onChange={(event) => setDraft({ ...draft, transitionId: event.target.value })}>
                <option value="">{issue.status} (current)</option>
                {transitions.map((transition) => <option key={transition.id} value={transition.id}>{transition.status}</option>)}
              </select>
            </label>
          </div>
        ) : (
          <dl className="jira-fields">
            <div className="jira-wide"><dt>Description</dt><dd className="jira-description">{issue.description || "None"}</dd></div>
            <div><dt>Story points</dt><dd>{points || "Not set"}</dd></div>
            <div><dt>Sprint</dt><dd>{issue.sprints.length ? issue.sprints.join(", ") : "None"}</dd></div>
            <div><dt>Labels</dt><dd>{issue.labels.length ? issue.labels.map((label) => <span className="chip" key={label}>{label}</span>) : "None"}</dd></div>
            <div><dt>Reporter</dt><dd>{issue.reporter}</dd></div>
          </dl>
        )}

        <div className="jira-actions">
          {draft ? (
            <>
              <button className="button small primary" type="button" disabled={saving || changeCount === 0} onClick={() => void save()}>
                {saving ? "Saving…" : changeCount === 0 ? "Save to Jira" : `Save ${changeCount} ${changeCount === 1 ? "change" : "changes"} to Jira`}
              </button>
              <button className="button small quiet" type="button" disabled={saving} onClick={() => setDraft(null)}>Cancel</button>
            </>
          ) : (
            <button className="button small" type="button" onClick={() => void startEditing()}>Edit</button>
          )}
          {message.text && <p className={message.isError ? "jira-message is-error" : "jira-message"} role={message.isError ? "alert" : "status"}>{message.text}</p>}
        </div>
      </div>
    </li>
  );
}

export function JiraReport({ source }: { source: Source<JiraIssue> }) {
  return (
    <Panel title="Jira" icon={<SourceLogo name="jira" />} count={source.status === "ready" ? source.items.length : null} id="report-jira">
      <SourceState source={source} empty="No Jira issues are assigned to you." />
      {source.items.length > 0 && (
        <ul className="rows">
          {source.items.map((issue) => <JiraRow key={issue.key} issue={issue} onSaved={source.reload} />)}
        </ul>
      )}
    </Panel>
  );
}
