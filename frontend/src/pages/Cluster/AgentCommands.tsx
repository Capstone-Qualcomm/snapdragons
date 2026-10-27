import { useEffect, useState } from "react";
import { Icon } from "../../components/Icon";
import { StatusDot } from "../../components/ui";
import type { Tone } from "../../components/ui";
import { boardOf } from "./Boards";
import { boardName } from "./cluster";
import type { ClusterState } from "./cluster";

// Sends a command to the gateway and reloads the state. Resolves to the
// gateway's error, or null when it took the command.
export type Run = (path: string, body?: unknown) => Promise<string | null>;

type Message = { text: string; ok: boolean };

const tone: Record<ReturnType<typeof boardOf>["state"], Tone> = { dead: "bad", left: "off", joining: "warn", leaving: "warn", working: "busy", idle: "ok" };
const words: Record<ReturnType<typeof boardOf>["state"], string> = { dead: "down", left: "removed", joining: "joining", leaving: "leaving", working: "working", idle: "idle" };

// Every command the boards take, in one place: the ones for the whole cluster,
// then the ones for a single agent, picked from the chips. Terminate asks once
// more before it kills, since a killed board stays down until it is restarted.
export function AgentCommands({ cluster, run }: { cluster: ClusterState | null; run: Run }) {
  const [picked, setPicked] = useState<string | null>(null);
  // The board a Terminate is waiting to be confirmed for. Holding its id, not a
  // yes/no, means the confirming click can only ever kill the board it named.
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);
  // Real boards join by themselves, so Add Agent becomes the command a new board runs.
  const [joining, setJoining] = useState(false);

  // A success note fades after a few seconds; an error stays until the next command.
  useEffect(() => {
    if (!message?.ok) return;
    const timer = setTimeout(() => setMessage(null), 6000);
    return () => clearTimeout(timer);
  }, [message]);

  const nodes = cluster?.nodes ?? [];
  const up = nodes.filter((node) => node.up).length;
  // The picked board, or the first one until one is picked or after the picked one is gone.
  const target = nodes.find((node) => node.id === picked) ?? nodes[0];
  const board = target && cluster ? boardOf(target, cluster) : null;
  const name = target ? boardName(target.id) : "";
  const canTerminate = Boolean(target?.up);
  const canRestart = board?.state === "dead";
  const canRemove = board ? board.state === "dead" || (Boolean(target?.up) && board.state !== "leaving") : false;

  async function command(path: string, done: string, body?: unknown) {
    setConfirming(null);
    setBusy(true);
    const error = await run(path, body);
    setBusy(false);
    setMessage(error ? { text: error, ok: false } : { text: done, ok: true });
  }

  function pick(id: string) {
    setPicked(id);
    setConfirming(null);
  }

  const nodePath = (action: string) => `/api/cluster/nodes/${target!.id}/${action}`;
  // Raft needs a majority of the members up to elect an orchestrator or commit
  // anything. If this terminate leaves fewer, nothing recovers until a board restarts.
  const members = cluster?.members.length ?? 0;
  const needed = Math.floor(members / 2) + 1;
  const upAfter = nodes.filter((node) => node.up && node.member && node.id !== target?.id).length;
  const breaksQuorum = Boolean(target?.member) && upAfter < needed;
  const stall = `Only ${upAfter} of ${members} boards would be up and Raft needs ${needed}, so the cluster stops until you restart a board.`;
  const afterTerminate = breaksQuorum
    ? stall.replace("would be", "are")
    : board?.isOrchestrator ? "The other boards will elect a new orchestrator." : board?.task ? "Its step moves to another board once its 2 s lease runs out." : "It had no step, so no work moves.";
  // Confirm only while the board it was opened for is still the target and still up.
  const confirmed = confirming !== null && confirming === target?.id && canTerminate;

  return (
    <section className="panel agent-commands" aria-labelledby="commands-title">
      <header className="panel-head">
        <h2 id="commands-title">Agent Commands</h2>
        <span className="panel-meta">Manage your agents</span>
      </header>

      <div className="command-groups">
        <div className="command-group" role="group" aria-labelledby="commands-cluster">
          <h3 className="command-label" id="commands-cluster">Cluster</h3>
          <div className="command-row">
            <button className="button small primary" type="button" disabled={!cluster?.orchestrator || busy} onClick={() => void command("/api/cluster/refresh", "Refresh queued.")}>
              <Icon name="play" size={14} />
              Run Refresh
            </button>
            {cluster?.boards ? (
              <button className="button small" type="button" aria-expanded={joining} onClick={() => setJoining(!joining)}>
                <Icon name="plus" size={14} />
                Connect a Board
              </button>
            ) : (
              <button className="button small" type="button" disabled={!cluster || nodes.length >= cluster.maxNodes || busy} onClick={() => void command("/api/cluster/nodes", "Adding an agent.")}>
                <Icon name="plus" size={14} />
                Add Agent
              </button>
            )}
            <button className="button small" type="button" disabled={!up || busy} onClick={() => void command("/api/cluster/restart", "Restarting every agent.")}>
              <Icon name="restart" size={14} />
              Restart All
            </button>
            <label className="switch">
              <input type="checkbox" checked={cluster?.auto ?? false} disabled={!cluster || busy} onChange={(event) => void command("/api/cluster/auto", `Auto refresh ${event.target.checked ? "on" : "off"}.`, { on: event.target.checked })} />
              <span className="switch-track" aria-hidden="true" />
              Auto refresh
            </label>
          </div>
          {joining && cluster?.join && (
            <div className="command-row join-board">
              <p>On the Uno Q, in a terminal or over SSH, run this once with your name and the tailnet key. The board sets itself up and joins in about a minute.</p>
              <code>{cluster.join}</code>
              <button className="button small" type="button" onClick={() => navigator.clipboard?.writeText(cluster.join!)}>
                Copy
              </button>
            </div>
          )}
        </div>

        <div className="command-group" role="group" aria-labelledby="commands-agent">
          <h3 className="command-label" id="commands-agent">Agent</h3>
          <div className="command-row">
            <div className="chips target-chips" role="group" aria-label="Target agent">
              {cluster && nodes.map((node) => {
                const { state, isOrchestrator } = boardOf(node, cluster);
                return (
                  <button key={node.id} className="chip-button" type="button" aria-pressed={node.id === target?.id} onClick={() => pick(node.id)}>
                    <StatusDot tone={tone[state]} />
                    {boardName(node.id)}
                    {isOrchestrator && <Icon name="crown" size={13} className="crown-icon" />}
                    <span className="sr-only">, {isOrchestrator ? "orchestrator, " : ""}{words[state]}</span>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="command-row">
            {confirmed ? (
              <>
                <button className="button small is-danger" type="button" disabled={busy} onClick={() => void command(`/api/cluster/nodes/${confirming}/kill`, `Terminated ${name}. ${afterTerminate}`)}>
                  <Icon name="power" size={14} />
                  Confirm Terminate
                </button>
                <button className="button small quiet" type="button" onClick={() => setConfirming(null)}>Cancel</button>
                <span className={`command-hint${breaksQuorum ? " is-warn" : ""}`}>{breaksQuorum ? stall : `${name} stops at once, like a board losing power.`}</span>
              </>
            ) : (
              <>
                <button className="button small is-kill" type="button" disabled={!canTerminate || busy} onClick={() => setConfirming(target!.id)}>
                  <Icon name="power" size={14} />
                  Terminate Agent
                </button>
                <button className="button small" type="button" disabled={!canRestart || busy} onClick={() => void command(nodePath("start"), `Restarting ${name} from what it saved.`)}>
                  <Icon name="restart" size={14} />
                  Restart Agent
                </button>
                <button className="button small quiet" type="button" disabled={!canRemove || busy} onClick={() => void command(nodePath("remove"), `${name} leaves the cluster after its current step.`)}>
                  <Icon name="trash" size={14} />
                  Remove Agent
                </button>
              </>
            )}
          </div>
        </div>
      </div>

      {message && (
        <p className={`command-status ${message.ok ? "is-ok" : "is-bad"}`} role={message.ok ? "status" : "alert"}>
          {message.text}
        </p>
      )}
    </section>
  );
}
