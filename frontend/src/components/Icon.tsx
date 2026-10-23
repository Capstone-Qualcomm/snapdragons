import { appPath } from "../lib/urls";

// Line icons on a 24-unit grid, drawn with the current text color. Slack, Jira
// and GitHub use their own logos.
const PATHS: Record<string, string> = {
  mail: "M4 6h16a1 1 0 0 1 1 1v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a1 1 0 0 1 1-1z M3.5 7l8.5 6 8.5-6",
  globe: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M3 12h18 M12 3c2.5 2.7 3.6 5.7 3.6 9s-1.1 6.3-3.6 9c-2.5-2.7-3.6-5.7-3.6-9S9.5 5.7 12 3z",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M3 10h18 M8 3v4 M16 3v4",
  doc: "M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z M14 3v5h5 M9 13h6 M9 17h4",
  log: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M7 9l3 3-3 3 M13 15h4",
  diff: "M6 3v12 M6 15a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M18 3a3 3 0 1 0 0 6a3 3 0 1 0 0-6z M18 9a9 9 0 0 1-9 9",
  reply: "M9 14L4 9l5-5 M4 9h10a6 6 0 0 1 6 6v3",
  list: "M9 6h11 M9 12h11 M9 18h11 M4 6l1 1 2-2 M4 12l1 1 2-2 M4 18l1 1 2-2",
  resume: "M6 3h12a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z M12 7a2.5 2.5 0 1 0 0 5a2.5 2.5 0 1 0 0-5z M8 17a4 4 0 0 1 8 0",
  rank: "M5 20v-6 M12 20V4 M19 20v-10",
  invoice: "M6 3h12v18l-3-2-3 2-3-2-3 2z M9 8h6 M9 12h6 M9 16h3",
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.4A8 8 0 1 1 21 12z",
  merge: "M7 4v5a5 5 0 0 0 5 5h7 M16 11l3 3-3 3 M7 20v-6",
  search: "M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4",
  paper: "M5 4a1 1 0 0 1 1-1h12v15H6a2 2 0 0 0-2 2V4z M4 20a2 2 0 0 0 2 2h12v-4 M8 7h6 M8 11h4",
  sparkle: "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z M19 16l.7 1.8 1.8.7-1.8.7L19 21l-.7-1.8-1.8-.7 1.8-.7z",
  today: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2z M3 10h18 M8 3v4 M16 3v4 M8 15l2 2 4-4",
  cluster: "M5 4h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M5 13h14a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2z M7 7.5h.01 M7 16.5h.01",
  plug: "M9 2v5 M15 2v5 M6 7h12v4a6 6 0 0 1-12 0z M12 17v5",
  crown: "M3 18h18 M4 8l4 4 4-7 4 7 4-4-1.5 10h-13z",
  x: "M6 6l12 12 M18 6L6 18",
  check: "M5 12.5l4.5 4.5L19 7.5",
  more: "M5 12h.01 M12 12h.01 M19 12h.01",
  menu: "M4 7h16 M4 12h16 M4 17h16",
  bolt: "M13 2L4 14h7l-1 8 9-12h-7z",
  stop: "M7 7h10v10H7z",
  play: "M8 5l11 7-11 7z",
  chevron: "M9 6l6 6-6 6",
  info: "M12 3a9 9 0 1 0 0 18a9 9 0 1 0 0-18z M12 11v5 M12 8h.01",
};

export type IconName = keyof typeof PATHS | "slack" | "jira" | "github";

export function Icon({ name, size = 16, className = "" }: { name: IconName | string; size?: number; className?: string }) {
  if (name === "slack" || name === "jira" || name === "github") {
    return <img className={`icon logo-img logo-${name} ${className}`} src={appPath(`${name}-logo.png`)} alt="" width={size} height={size} />;
  }
  return (
    <svg className={`icon ${className}`} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.doc} />
    </svg>
  );
}

// A step's icon in a soft tile of its own color, so each kind of work is recognizable at a glance.
export function IconTile({ name, size = 16 }: { name: string; size?: number }) {
  return (
    <span className={`icon-tile tint-${name}`} aria-hidden="true">
      <Icon name={name} size={size} />
    </span>
  );
}
