# Cluster

The cluster on one laptop. Each node is one process standing in for one Uno Q board, and talks to the others only over HTTP, so the same code can run on the boards later.

Every node runs a Raft peer, its copy of the task queue, and a worker. The Raft leader is called the orchestrator here and the followers are workers, since every node also runs steps. The orchestrator appends each queue change to its log and copies it to the others; a change counts once a majority has it, and every node applies it in the same order. If the orchestrator dies, the others elect a new one and nothing committed is lost.

- `raft.ts` the Raft peer: terms, elections, log replication, commit, snapshots and one-at-a-time membership changes
- `queue.ts` the queue Raft replicates: steps, claims, checkpoints, completions and job times
- `worker.ts` the work loop: claim a step, report progress in each heartbeat, finish it
- `node.ts` one node process: the three above, plus the HTTP routes the other nodes call
- `server.ts` the gateway on port 3003 for the Cluster view and Today. It starts and stops node processes, reads each node's Raft status and the orchestrator's queue, and passes requests on. It holds no queue itself

## Run it

```
./scripts/start-cluster.sh
```

That starts the gateway and nodes Q-01 to Q-03 (`CLUSTER_NODES=3`) with auto refresh on (`CLUSTER_AUTO=1`). Each node saves its Raft term, vote and log to `CLUSTER_DATA` (a folder in the system temp dir by default), so restarting the cluster picks up where it was, with every node it had then. Delete that folder to start empty.

Kill a node from a terminal the way a board loses power:

```
./scripts/kill-worker.sh Q-02
```

## What happens when

- **A node dies mid-step.** The orchestrator stops hearing from it, and after `LEASE_MS` (2 s) puts its step back in the queue. The next node starts from the last checkpoint the dead one reported, not from zero.
- **The orchestrator dies.** The others stop getting its heartbeats, one times out (1.5 to 3 s, random), asks for votes and becomes the new orchestrator for a higher term. Work pauses for that long and then carries on. A node only votes for a candidate whose log has everything it has, so the new orchestrator has every committed change.
- **Remove.** The node finishes its step, leaves the queue, then takes itself out of the members through the log.
- **Add.** A new node starts empty and the orchestrator adds it to the members through the log, then sends it everything.
- **Every node restarts.** Each one reloads what it saved; they elect an orchestrator, which replays the log once its first entry commits.

## Gateway routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cluster/state` | The queue, recent jobs and events, and each node's Raft status |
| POST | `/api/cluster/refresh` | Queue one morning refresh: a fetch for each of Jira, Slack and GitHub, then a ranking step that waits for them |
| POST | `/api/cluster/auto` | `{ "on": true }` starts the next refresh shortly after each one finishes |
| POST | `/api/cluster/nodes` | Add the next unused node, up to six. With every node down, start the saved members again |
| POST | `/api/cluster/nodes/:id/start` | Restart a dead node from what it saved |
| POST | `/api/cluster/nodes/:id/kill` | SIGKILL a node, like a board losing power |
| POST | `/api/cluster/nodes/:id/remove` | Remove a node after its current step |
| POST | `/api/cluster/restart` | Kill every node, then start them all again |

Timings, all in milliseconds: `WORK_MS` (3000 per step), `LEASE_MS` (2000), `RAFT_HEARTBEAT_MS` (300), `RAFT_ELECTION_MIN_MS` and `RAFT_ELECTION_MAX_MS` (1500 and 3000).

## Tests

```
cd backend/cluster && npm test
node --test tests/integration/cluster.test.ts   # from the repo root, real node processes
```
