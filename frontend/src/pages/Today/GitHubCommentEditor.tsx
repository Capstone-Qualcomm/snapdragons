import { useState } from "react";
import { postGitHubComment } from "./github";
import type { GitHubIssue } from "./sources";

export function GitHubCommentEditor({ issue, id, onClose, onPostingChange }: { issue: GitHubIssue; id: string; onClose: () => void; onPostingChange: (posting: boolean) => void }) {
  const [body, setBody] = useState("");
  const [posting, setPosting] = useState(false);
  const [message, setMessage] = useState({ text: "", isError: false });

  async function post() {
    setPosting(true);
    onPostingChange(true);
    setMessage({ text: "", isError: false });
    try {
      await postGitHubComment(issue.repository, issue.number, body);
      setBody("");
      setMessage({ text: "Comment posted to GitHub.", isError: false });
    } catch (cause) {
      setMessage({ text: (cause as Error).message, isError: true });
    } finally {
      setPosting(false);
      onPostingChange(false);
    }
  }

  return (
    <div className="jira-details" id={id}>
      <div className="jira-fields">
        <div className="jira-wide">
          <strong>Comment on {issue.repository}#{issue.number}</strong>
        </div>
        <label className="jira-wide">
          Comment
          <textarea value={body} rows={4} maxLength={65_536} disabled={posting} onChange={(event) => setBody(event.target.value)} placeholder="Write a comment. Markdown is supported." />
        </label>
      </div>
      <div className="jira-actions">
        <button className="button small primary" type="button" disabled={posting || !body.trim()} onClick={() => void post()}>
          {posting ? "Posting…" : "Post comment to GitHub"}
        </button>
        <button className="button small quiet" type="button" disabled={posting} onClick={onClose}>Close</button>
        {message.text && <p className={message.isError ? "jira-message is-error" : "jira-message"} role={message.isError ? "alert" : "status"}>{message.text}</p>}
      </div>
    </div>
  );
}
