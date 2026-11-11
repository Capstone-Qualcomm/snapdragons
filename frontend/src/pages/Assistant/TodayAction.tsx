import { useState } from "react";
import { api } from "../../lib/api";
import { postGitHubComment } from "../Today/github";
import { getJiraTransitions, updateJiraIssue } from "../Today/jira";
import type { JiraChanges, JiraTransition } from "../Today/jira";
import type { Source } from "../Today/sources";

type TodaySource = "jira" | "github" | "outlook" | "slack";
type Target = { ready: false; question: string } | { ready: true; source: TodaySource; itemId: string; todayId: string; title: string; action: string };
type Proposal = { ready: false; question: string } | { ready: true; source: TodaySource; itemId: string; todayId: string; title: string; action: string; value: string | number | null };

function itemsForModel(sources: Source<any>[]) {
  let completed: unknown = [];
  try { completed = JSON.parse(localStorage.getItem("continuum-done") ?? "[]"); } catch { /* no saved local state */ }
  const doneIds = Array.isArray(completed) ? completed : [];
  return sources.flatMap((source) => source.items.slice(0, 25).map((item: any) => {
    const id = source.name === "jira" ? item.key : item.id;
    const timestamp = source.name === "jira" ? item.updated : source.name === "slack" ? item.sentAt : source.name === "github" ? item.updatedAt : item.receivedAt;
    const at = timestamp ? new Date(timestamp).getTime() || 0 : 0;
    const todayId = `${source.name}:${id}@${at}`;
    const done = doneIds.includes(todayId);
    if (source.name === "jira") return { source: source.name, id, todayId, done, title: item.summary, context: `${item.key} · ${item.status} · ${item.issueType}`, details: item.description };
    if (source.name === "github") return { source: source.name, id, todayId, done, title: item.title, context: `${item.repository}#${item.number} · ${item.kind} · ${item.state}` };
    if (source.name === "outlook") return { source: source.name, id, todayId, done, title: item.subject, context: `From ${item.from}` };
    return { source: source.name, id, todayId, done, title: item.text, context: `${item.kind} from ${item.from} in ${item.where}` };
  }));
}

export function TodayAction({ initialRequest = "", sources, onComplete }: { initialRequest?: string; sources: Source<any>[]; onComplete?: () => void }) {
  const [request, setRequest] = useState(initialRequest);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [transitions, setTransitions] = useState<JiraTransition[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  async function prepare() {
    setBusy(true); setError(""); setMessage(""); setProposal(null);
    try {
      const target = await api<Target>("/api/assistant/action/prepare", { prompt: request, items: itemsForModel(sources) });
      if (!target.ready) { setProposal(target); return; }
      if (target.action === "markDone" || target.action === "undoDone") {
        setProposal({ ...target, ready: true, value: null });
        return;
      }
      let context = "";
      if (target.action === "reply" && target.source === "outlook") {
        const { messages } = await api<{ messages: Array<{ from: string; subject: string; receivedAt: string; content: string }> }>(`/api/outlook/messages/${encodeURIComponent(target.itemId)}/thread`);
        context = messages.map((item) => `${item.from} · ${item.receivedAt} · ${item.subject}\n${item.content}`).join("\n\n").slice(-12_000);
      } else if (target.action === "reply" && target.source === "slack") {
        const { messages } = await api<{ messages: Array<{ from: string; sentAt: string; text: string }> }>(`/api/slack/messages/${encodeURIComponent(target.itemId)}/context`);
        context = messages.map((item) => `${item.from} · ${item.sentAt}\n${item.text}`).join("\n\n").slice(-12_000);
      }
      const result = await api<Proposal>("/api/assistant/action/prepare", { prompt: request, items: itemsForModel(sources), target: { source: target.source, itemId: target.itemId, action: target.action }, context });
      setProposal(result);
      if (result.ready && result.source === "jira" && result.action === "status") {
        setTransitions(await getJiraTransitions(result.itemId));
      }
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function confirm() {
    if (!proposal?.ready) return;
    setBusy(true); setError("");
    try {
      if (proposal.action === "markDone" || proposal.action === "undoDone") {
        let done: string[] = [];
        try { done = JSON.parse(localStorage.getItem("continuum-done") ?? "[]"); } catch { /* no saved local state */ }
        const next = proposal.action === "markDone" ? [...done.filter((id) => id !== proposal.todayId), proposal.todayId].slice(-300) : done.filter((id) => id !== proposal.todayId);
        localStorage.setItem("continuum-done", JSON.stringify(next));
        window.dispatchEvent(new Event("today-done-updated"));
      } else if (proposal.source === "jira") {
        let changes: JiraChanges;
        if (proposal.action === "status") {
          const transition = transitions.find(({ status }) => status.trim().toLocaleLowerCase() === String(proposal.value).trim().toLocaleLowerCase());
          if (!transition) throw new Error(`Jira does not offer a transition to “${proposal.value}” for ${proposal.itemId}.`);
          changes = { transitionId: transition.id };
        } else if (proposal.action === "description") changes = { description: String(proposal.value) };
        else changes = { storyPointEstimate: proposal.value as number | null };
        await updateJiraIssue(proposal.itemId, changes);
        window.dispatchEvent(new Event("jira-issue-updated"));
      } else if (proposal.source === "github") {
        const item = sources.find((source) => source.name === "github")?.items.find((candidate: any) => candidate.id === proposal.itemId) as { repository: string; number: number } | undefined;
        if (!item) throw new Error("That GitHub item is no longer in Today. Refresh and try again.");
        await postGitHubComment(item.repository, item.number, String(proposal.value));
      } else if (proposal.source === "outlook") {
        const path = `/api/outlook/messages/${encodeURIComponent(proposal.itemId)}/${proposal.action === "delete" ? "delete" : "reply"}`;
        await api(path, proposal.action === "delete" ? {} : { comment: String(proposal.value) });
        if (proposal.action === "delete") window.dispatchEvent(new CustomEvent("outlook-message-deleted", { detail: proposal.itemId }));
      } else {
        await api(`/api/slack/messages/${encodeURIComponent(proposal.itemId)}/message`, { text: String(proposal.value) });
      }
      await Promise.all(sources.filter((source) => source.name === proposal.source).map((source) => source.reload()));
      setMessage("Action completed.");
      setProposal(null);
      onComplete?.();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  const targetUnavailable = proposal?.ready && proposal.source === "jira" && proposal.action === "status" && !transitions.some(({ status }) => status.trim().toLocaleLowerCase() === String(proposal.value).trim().toLocaleLowerCase());
  const actionName = proposal?.ready ? ({ status: "Change status", description: "Replace description", storyPoints: "Set story points", comment: "Post GitHub comment", reply: proposal.source === "slack" ? "Send Slack reply" : "Send Outlook reply", delete: "Delete email", markDone: "Mark done", undoDone: "Restore to Today" } as Record<string, string>)[proposal.action] ?? proposal.action : "";
  return (
    <section className="today-action" aria-label="Today action">
      <label htmlFor="today-action-request">What should I do in your connected apps?</label>
      <textarea id="today-action-request" value={request} rows={3} onChange={(event) => { setRequest(event.target.value); setProposal(null); setMessage(""); }} placeholder="For example: reply to the email from Sam, update my ticket, or comment on the pull request." />
      <div className="today-action-buttons">
        <button className="button primary" type="button" disabled={busy || !request.trim()} onClick={() => void prepare()}>{busy ? "Working…" : "Prepare action"}</button>
      </div>
      {error && <p className="today-action-message is-error" role="alert">{error}</p>}
      {message && <p className="today-action-message" role="status">{message}</p>}
      {proposal && !proposal.ready && <p className="today-action-message" role="status">{proposal.question}</p>}
      {proposal?.ready && (
        <div className="today-action-review">
          <p>{actionName}: <strong>{proposal.title}</strong></p>
          {!(["delete", "markDone", "undoDone"].includes(proposal.action)) && <dl><dt>Content</dt><dd>{proposal.value === null ? "Clear estimate" : String(proposal.value)}</dd></dl>}
          {targetUnavailable && <p className="today-action-message is-error">That status is not available for this item.</p>}
          <button className="button primary" type="button" disabled={busy || Boolean(targetUnavailable)} onClick={() => void confirm()}>{busy ? "Saving…" : "Confirm action"}</button>
        </div>
      )}
    </section>
  );
}
