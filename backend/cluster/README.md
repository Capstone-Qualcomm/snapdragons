# Cluster

A fake cluster for a laptop: one task queue and worker processes that claim tasks from it. The workers only talk to the queue over HTTP, so the same worker can run on an Uno Q board later by pointing `CLUSTER_URL` at the machine running the queue.

- `queue.ts` holds the tasks in memory and hands each one to a single worker
- `server.ts` puts the queue behind HTTP on port 3003. It can also start and kill worker processes for the Console page
- `worker.ts` is one worker process. It claims a task, waits about `WORK_MS` to stand in for real work, then reports the result

## Run it

From the repo root (run `npm install` in `backend/cluster` first if you want the typecheck):

```
./scripts/start-cluster.sh
```

That starts the queue, which starts three workers named Q-01, Q-02 and Q-03 (`CLUSTER_NODES=3`), queues 9 tasks and prints how many each worker finished. Pass a number to queue a different amount.

To run the pieces by hand, each in its own terminal:

```
cd backend/cluster
npm start
WORKER_ID=Q-01 npm run worker
curl -X POST localhost:3003/api/cluster/tasks -d '{"input":"hello"}'
```

## Failover

A busy worker sends a heartbeat every second. If the queue hears nothing from a worker for 2 seconds (`LEASE_MS`), its lease expires and its task goes back in the queue for the next worker that asks. If the old worker comes back and tries to finish it, it gets a 409.

To see it, run the cluster with long tasks and kill a worker mid-task while the Console page is open:

```
WORK_MS=8000 ./scripts/start-cluster.sh
./scripts/kill-worker.sh Q-02
```

The task starts over on the new worker. Picking up from a checkpoint, as the concept page shows, comes later.

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cluster/state` | Every task, and what each worker holds and has finished |
| POST | `/api/cluster/tasks` | Queue a task: `{ "input": "..." }` |
| POST | `/api/cluster/claim` | A worker asks for work: `{ "worker": "Q-01" }`. `task` is null when the queue is empty |
| POST | `/api/cluster/heartbeat` | A busy worker says it is still alive: `{ "worker": "Q-01" }` |
| POST | `/api/cluster/complete` | A worker reports a result: `{ "id", "worker", "result" }`. 409 if that worker does not hold the task |
| POST | `/api/cluster/jobs` | Queue a job as steps that run at the same time: `{ "name", "steps": [...], "then": "..." }`. `then` is optional and waits for every other step |
| POST | `/api/cluster/nodes` | Start the next unused node, up to six |
| POST | `/api/cluster/nodes/:id/start` | Start or restart one node that is not running |
| POST | `/api/cluster/nodes/:id/kill` | SIGKILL a node the server started, like a board losing power |

## Limits

The Console is public, so the server keeps things small: only Q-01 to Q-06 can claim work or be started, at most 30 tasks can be waiting or running (429 past that), a job has at most 8 steps, names and inputs are at most 80 characters and bodies at most 4 KB. Only the last 50 done tasks and 40 events are kept. Workers the server starts take `WORK_MS` (default 4000) per step, so there is time to kill one mid-step.

## Tests

```
cd backend/cluster && npm test
```

## Not done yet

- The queue is in memory, so restarting the server loses it.
- The work is a timer. Real tasks come once the assistant side has something to hand out.
