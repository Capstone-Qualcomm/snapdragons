import { useEffect, useState } from "react";
import { appPath } from "../lib/urls";

// The shared pieces every page is built from. Styles live in styles/panels.css.

// ok: live or done. busy: working right now, pulses. warn: waiting or turned
// off. bad: failed. off: idle or not connected.
export type Tone = "ok" | "busy" | "warn" | "bad" | "off";

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`dot tone-${tone}`} aria-hidden="true" />;
}

export function SourceLogo({ name }: { name: "jira" | "slack" | "github" }) {
  return <img className={`logo logo-${name}`} src={appPath(`${name}-logo.png`)} alt="" />;
}

export function ErrorBanner({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-banner" role="alert">
      <p>{message}</p>
      {onRetry && <button className="text-button" type="button" onClick={onRetry}>Retry</button>}
    </div>
  );
}

// Placeholder rows until the first answer comes back.
export function SkeletonRows({ count = 3 }: { count?: number }) {
  return (
    <div className="skeleton" role="status" aria-label="Loading">
      {Array.from({ length: count }, (_, index) => <div className="skeleton-row" key={index}><i /><i /></div>)}
    </div>
  );
}

// The current time, updated every 30 seconds, for anything that says "4 min ago".
export function useNow(interval = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), interval);
    return () => clearInterval(timer);
  }, [interval]);
  return now;
}

export function relative(time: string | number, now = Date.now()) {
  const minutes = Math.round((now - new Date(time).getTime()) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  return new Date(time).toLocaleDateString([], { month: "short", day: "numeric" });
}

export function RelativeTime({ value }: { value: string | number }) {
  const now = useNow();
  return <time dateTime={new Date(value).toISOString()} title={new Date(value).toLocaleString()}>{relative(value, now)}</time>;
}

// A stat card: a plain label, one big value with its unit, and a line saying what it counts.
export function Stat({ label, value, note, tone = "" }: { label: string; value: string; note: string; tone?: string }) {
  return (
    <li className={`stat ${tone}`}>
      <span className="stat-label">{label}</span>
      <strong className="stat-value">{value}</strong>
      <span className="stat-note">{note}</span>
    </li>
  );
}

// "12 s ago", "3 min ago".
export function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`;
}
