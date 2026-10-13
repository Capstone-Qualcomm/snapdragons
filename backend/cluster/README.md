# Cluster

A fake cluster for a laptop: one task queue and worker processes that claim tasks from it. The workers only talk to the queue over HTTP, so the same worker can run on an Uno Q board later by pointing `CLUSTER_URL` at the machine running the queue.

- `queue.ts` holds the tasks in memory and hands each one to a single worker
- `server.ts` puts the queue behind HTTP on port 3003
- `worker.ts` is one worker process. It claims a task, waits `WORK_MS` to stand in for real work, then reports the result

## Run it

From the repo root (run `npm install` in `backend/cluster` first if you want the typecheck):

```
./scripts/start-cluster.sh
```

That starts the queue and three workers named Q-01, Q-02 and Q-03, queues 9 tasks and prints how many each worker finished. Pass a number to queue a different amount.

To run the pieces by hand, each in its own terminal:

```
cd backend/cluster
npm start
WORKER_ID=Q-01 npm run worker
curl -X POST localhost:3003/api/cluster/tasks -d '{"input":"hello"}'
```

## Routes

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/cluster/state` | Every task, and what each worker holds and has finished |
| POST | `/api/cluster/tasks` | Queue a task: `{ "input": "..." }` |
| POST | `/api/cluster/claim` | A worker asks for work: `{ "worker": "Q-01" }`. `task` is null when the queue is empty |
| POST | `/api/cluster/complete` | A worker reports a result: `{ "id", "worker", "result" }`. 409 if that worker does not hold the task |

## Tests

```
cd backend/cluster && npm test
```

## Not done yet

- A claim never expires. If a worker dies mid-task, the task stays claimed. That is QT1S-9.
- The queue is in memory, so restarting the server loses it.
- The work is a timer. Real tasks come once the assistant side has something to hand out.
