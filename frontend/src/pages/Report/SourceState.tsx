import { EmptyState, ErrorBanner, SkeletonRows } from "../../components/ui";
import { appPath } from "../../lib/urls";
import type { Source } from "./useSource";

// What a Report panel shows instead of its list: still loading, not set up,
// not connected, turned off, failed, or nothing to do. Null once there are items.
export function SourceState({ source, empty }: { source: Source<unknown>; empty: string }) {
  const { title } = source;
  switch (source.status) {
    case "loading":
      return <SkeletonRows />;
    case "unconfigured":
      return <EmptyState>{title} sign-in is not set up on this server.</EmptyState>;
    case "disconnected":
      return <EmptyState action={<a className="button small primary" href={appPath(`auth/${source.name}/start`)}>Connect {title}</a>}>{title} is not connected.</EmptyState>;
    case "disabled":
      return <EmptyState action={<button className="button small" type="button" onClick={() => void source.enable()}>Turn on</button>}>{title} is turned off.</EmptyState>;
    case "error":
      return <ErrorBanner message={source.error} onRetry={() => void source.reload()} />;
    case "ready":
      return source.items.length === 0 ? <EmptyState>{empty}</EmptyState> : null;
  }
}
