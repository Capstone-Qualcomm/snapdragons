import { useEffect, useState } from "react";
import { ErrorBanner } from "../../components/ui";
import { api } from "../../lib/api";
import "./Sample.css";

type Email = { id: number; from: { name: string; email: string }; date: string; subject: string; body: string; attachments?: Array<{ name: string; text: string }> };
type Busy = { who: string; day: string; start: string; end: string; what: string };
type Sample = { emails: Email[]; busy: Busy[]; week: string[] };

const day = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const sent = (date: string) => new Date(date).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

// The demo data a live scenario runs on, to look through before running it:
// the inbox the boards will read and the panel's calendar.
export function SampleData({ scenario, title, onClose }: { scenario: string; title: string; onClose: () => void }) {
  const [sample, setSample] = useState<Sample | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"inbox" | "calendar">("inbox");
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    api<Sample>(`/api/assistant/scenarios/${scenario}/sample`).then((data) => {
      setSample(data);
      setOpen(data.emails[0]?.id ?? null);
    }, (cause: Error) => setError(cause.message));
  }, [scenario]);

  const email = sample?.emails.find((entry) => entry.id === open);
  const people = sample ? [...new Set(sample.busy.map((block) => block.who))] : [];

  return (
    <div className="sample-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="sample-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header className="sample-head">
          <strong>{title}</strong>
          <div className="sample-tabs" role="tablist">
            <button type="button" role="tab" aria-selected={tab === "inbox"} onClick={() => setTab("inbox")}>Inbox{sample && ` (${sample.emails.length})`}</button>
            <button type="button" role="tab" aria-selected={tab === "calendar"} onClick={() => setTab("calendar")}>Calendar</button>
          </div>
          <button className="header-button" type="button" aria-label="Close" onClick={onClose}>×</button>
        </header>
        {error && <ErrorBanner message={error} />}
        {sample && tab === "inbox" && (
          <div className="sample-inbox">
            <ol className="sample-list" aria-label="Emails">
              {sample.emails.map((entry) => (
                <li key={entry.id}>
                  <button type="button" aria-current={entry.id === open} onClick={() => setOpen(entry.id)}>
                    <span className="sample-from">{entry.from.name}</span>
                    <time>{sent(entry.date)}</time>
                    <span className="sample-subject">{entry.attachments?.length ? "📎 " : ""}{entry.subject}</span>
                  </button>
                </li>
              ))}
            </ol>
            {email && (
              <article className="sample-email">
                <h3>{email.subject}</h3>
                <p className="muted">{email.from.name} &lt;{email.from.email}&gt; · {sent(email.date)}</p>
                <div className="sample-body">{email.body}</div>
                {email.attachments?.map((file) => (
                  <details key={file.name} className="sample-attachment" open>
                    <summary>📎 {file.name}</summary>
                    <div className="sample-body">{file.text}</div>
                  </details>
                ))}
              </article>
            )}
          </div>
        )}
        {sample && tab === "calendar" && (
          <div className="sample-calendar">
            <table className="table">
              <thead>
                <tr><th>Who</th>{sample.week.map((date) => <th key={date}>{day(date)}</th>)}</tr>
              </thead>
              <tbody>
                {people.map((who) => (
                  <tr key={who}>
                    <th scope="row">{who}</th>
                    {sample.week.map((date) => (
                      <td key={date}>
                        {sample.busy.filter((block) => block.who === who && block.day === date).sort((a, b) => a.start.localeCompare(b.start)).map((block) => (
                          <span key={block.start} className="sample-block">{block.start}–{block.end} {block.what}</span>
                        ))}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="muted">Central time. Interviews go in the gaps, between 9 and 5.</p>
          </div>
        )}
      </section>
    </div>
  );
}
