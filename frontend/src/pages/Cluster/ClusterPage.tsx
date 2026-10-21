import { useEffect, useRef, useState } from "react";
import { SubTabs } from "../../components/ui";
import { Activity } from "./Activity";
import { Rack } from "./Boards";
import { send, useCluster } from "./cluster";
import { LatestRefresh, RefreshTimes } from "./Refresh";
import { Timeline } from "./Timeline";
import "./Cluster.css";

type Panel = "timeline" | "steps" | "times" | "activity";
const panels: Array<{ value: Panel; label: string }> = [
  { value: "timeline", label: "Timeline" },
  { value: "steps", label: "Steps" },
  { value: "times", label: "Refresh time" },
  { value: "activity", label: "Activity" },
];

export function ClusterPage() {
  const { cluster, failed, reload, serverNow } = useCluster();
  const [error, setError] = useState<string | null>(null);
  const [panel, setPanel] = useState<Panel>("timeline");
  const more = useRef<HTMLDetailsElement>(null);

  // The menu closes on a click anywhere else.
  useEffect(() => {
    function close(event: PointerEvent) {
      if (more.current?.open && !more.current.contains(event.target as Node)) more.current.open = false;
    }
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);

  async function act(path: string, body?: unknown) {
    setError(await send(path, body));
    void reload();
  }

  const up = cluster?.nodes.filter((node) => node.up).length ?? 0;

  return (
    <div className="cluster">
      <header className="page-head cluster-head">
        <div className="page-actions">
          <details className="more" ref={more}>
            <summary className="header-button" aria-label="More">
              <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 8h.01M8 8h.01M12.5 8h.01" /></svg>
            </summary>
            <div className="menu">
              <label className="switch menu-item">
                <input type="checkbox" checked={cluster?.auto ?? false} disabled={!cluster} onChange={(event) => void act("/api/cluster/auto", { on: event.target.checked })} />
                <span className="switch-track" aria-hidden="true" />
                Auto refresh
              </label>
              <button className="menu-item" type="button" disabled={!up} onClick={() => { more.current!.open = false; void act("/api/cluster/restart"); }}>
                Restart all nodes
              </button>
            </div>
          </details>
          <button className="button primary" type="button" disabled={!cluster?.orchestrator} onClick={() => void act("/api/cluster/refresh")}>
            Refresh
          </button>
        </div>
      </header>
      {(error || failed) && (
        <div className="error-banner" role="alert">
          <p>{error ?? (cluster ? "The cluster is not reachable. Showing the last received state." : "The cluster is not reachable.")}</p>
        </div>
      )}
      {cluster && (
        <>
          <Rack cluster={cluster} act={(path, body) => void act(path, body)} />
          <section className="cluster-detail">
            <SubTabs label="Cluster detail" items={panels} value={panel} onChange={setPanel} />
            {panel === "timeline" && <Timeline cluster={cluster} serverNow={serverNow} />}
            {panel === "steps" && <LatestRefresh cluster={cluster} now={serverNow()} />}
            {panel === "times" && <RefreshTimes jobs={cluster.jobs} members={cluster.members.length} maxNodes={cluster.maxNodes} />}
            {panel === "activity" && <Activity events={cluster.events} offset={serverNow() - Date.now()} />}
          </section>
        </>
      )}
    </div>
  );
}
