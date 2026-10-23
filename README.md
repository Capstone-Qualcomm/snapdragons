# SnapDragons

CS 620 capstone, Qualcomm Team 1. Persistent agent runtime that scales out across Arduino Uno Q nodes.

## Layout

- `frontend/` the app (React and Vite): Assistant (give the boards a job and watch them split it, on demo data), Today (your Slack, Jira and GitHub work, ranked), Cluster (the boards, refresh times and activity) and Connections
- `backend/jira/`, `backend/slack/` and `backend/github/` sign-in and data for each source, on ports 3001, 3002 and 3004. Code they share is in `backend/*.mts`
- `backend/cluster/` the cluster on one laptop: a gateway on port 3003 and node processes that share a Raft-replicated task queue
- `mvp/` concept landing page (static, run with `python3 -m http.server 8080` inside it)

## Running it

The backends need Node 22.18 or newer.

- `./scripts/start-dev.sh` starts the Jira, Slack and GitHub backends and the dashboard. It needs `backend/.env`, see `backend/.env.example`.
- `./scripts/start-cluster.sh` starts three nodes and refreshes on a loop. Leave it running and the Cluster page shows what each board is doing; the Assistant page runs its demo jobs on the same boards.
- To watch failover, `./scripts/kill-worker.sh Q-02` while the cluster works. If it was the orchestrator the others elect a new one, and its step moves to another node.
- `bash tests/local_tests.sh` runs the backend, integration and frontend tests. Pull requests run them on GitHub too.

## First-time setup

1. Send Sanyam your GitHub username, then accept the invite email from GitHub
2. Install git (macOS: `xcode-select --install`, Windows: https://git-scm.com/download/win)
3. Install the GitHub CLI (https://cli.github.com) and run `gh auth login`, which handles sign-in for git too
4. Tell git who you are:
   ```
   git config --global user.name "Your Name"
   git config --global user.email "you@wisc.edu"
   ```
5. Clone: `gh repo clone Capstone-Qualcomm/snapdragons`

## Workflow

1. Pull before starting: `git checkout main && git pull`
2. Branch off `main` for each task: `git checkout -b yourname/short-description`
3. Commit small, push, open a pull request into `main`
4. One teammate reviews before merging
5. Don't commit secrets. Put keys in `.env` (already gitignored)
