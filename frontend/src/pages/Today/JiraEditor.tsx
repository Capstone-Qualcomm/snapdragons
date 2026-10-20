import { useEffect, useState } from "react";
import { getJiraTransitions, updateJiraIssue } from "./jira";
import type { JiraChanges, JiraIssue, JiraTransition } from "./jira";

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

// The Jira fields under a Today row. It opens ready to edit; Save writes only
// what changed, then shows what Jira has.
export function JiraEditor({ issue, id, onSaved, onClose }: { issue: JiraIssue; id: string; onSaved: () => Promise<void>; onClose: () => void }) {
  // A draft exists only while editing; reading the details can't change anything.
  const [draft, setDraft] = useState<Draft | null>(() => draftOf(issue));
  // The values when Edit was clicked, so a sync while editing doesn't turn
  // Jira's newer values into changes.
  const [base, setBase] = useState<Draft | null>(() => draftOf(issue));
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  const changes = draft && base ? changesBetween(base, draft) : {};
  const changeCount = Object.keys(changes).length;
  const points = issue.storyPointEstimate == null ? "" : String(issue.storyPointEstimate);

  // The statuses it can move to, fetched again once a save changes its status.
  const { key, status } = issue;
  useEffect(() => {
    getJiraTransitions(key).then(setTransitions, (cause: Error) => setMessage({ text: cause.message, isError: true }));
  }, [key, status]);

  function startEditing() {
    setBase(draftOf(issue));
    setDraft(draftOf(issue));
    setMessage({ text: "", isError: false });
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
    <div className="jira-details" id={id}>
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
            <button className="button small quiet" type="button" disabled={saving} onClick={onClose}>Cancel</button>
          </>
        ) : (
          <button className="button small" type="button" onClick={startEditing}>Edit</button>
        )}
        {message.text && <p className={message.isError ? "jira-message is-error" : "jira-message"} role={message.isError ? "alert" : "status"}>{message.text}</p>}
      </div>
    </div>
  );
}

