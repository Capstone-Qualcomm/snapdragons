import { useEffect, useState } from "react";
import { appPath } from "../lib/urls";

// The shared pieces every page is built from. Styles live in styles/panels.css.

// ok: live or done. busy: working right now, pulses. warn: waiting or turned
// off. bad: failed. off: idle or not connected.
export type Tone = "ok" | "busy" | "warn" | "bad" | "off";

export function StatusDot({ tone }: { tone: Tone }) {
  return <span className={`dot tone-${tone}`} aria-hidden="true" />;
}

export function SourceLogo({ name }: { name: "jira" | "slack" | "github" | "outlook" }) {
  return <img className={`logo logo-${name}`} src={appPath(`${name}-logo.png`)} alt="" />;
}

// Equal segments on a quiet track; the selected one sits raised.
export function SubTabs<T extends string>({ items, value, onChange, label, nav }: {
  items: Array<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
  label: string;
  // Main navigation marks the current page; other switchers mark the pressed segment.
  nav?: boolean;
}) {
  return (
    <nav className="subtabs" aria-label={label}>
      {items.map((item) => (
        <button
          className={item.value === value ? "subtab is-on" : "subtab"}
          type="button"
          key={item.value}
          aria-current={nav && item.value === value ? "page" : undefined}
          aria-pressed={nav ? undefined : item.value === value}
          onClick={() => onChange(item.value)}
        >
          {item.label}
        </button>
      ))}
    </nav>
  );
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
