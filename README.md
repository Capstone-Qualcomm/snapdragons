# SnapDragons

CS 620 capstone, Qualcomm Team 1. Persistent agent runtime that scales out across Arduino Uno Q nodes.

## Layout

- `frontend/` the dashboard (React and Vite): Console, Report, Logs and Settings
- `backend/jira/`, `backend/slack/` and `backend/github/` sign-in and data for each source, on ports 3001, 3002 and 3004. Code they share is in `backend/*.mts`
- `backend/cluster/` task queue (port 3003) and worker processes, a fake cluster for one laptop
- `mvp/` concept landing page (static, run with `python3 -m http.server 8080` inside it)

## Running it

The backends need Node 22.18 or newer.

- `./scripts/start-dev.sh` starts the Jira, Slack and GitHub backends and the dashboard. It needs `backend/.env`, see `backend/.env.example`.
- `./scripts/start-cluster.sh` starts the queue and three workers. Leave it running and the Console page shows what each node is doing.
- To watch failover, start the cluster with `WORK_MS=8000 ./scripts/start-cluster.sh` so tasks last long enough, then `./scripts/kill-worker.sh Q-02` while it works.
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
