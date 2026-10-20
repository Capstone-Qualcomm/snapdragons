# SnapDragons

CS 620 capstone, Qualcomm Team 1. Persistent agent runtime that scales out across Arduino Uno Q nodes.

## Layout

- `frontend/` the dashboard (React and Vite)
- `backend/jira/` and `backend/slack/` sign-in and data for each source
- `backend/cluster/` the cluster on one laptop: node processes that share a Raft-replicated task queue
- `hardware/` Uno Q sketches
- `mvp/` concept landing page (static, run with `python3 -m http.server 8080` inside it)

## Running it

- `./scripts/start-dev.sh` starts the Jira and Slack backends and the dashboard. It needs `backend/.env`, see `backend/.env.example`.
- `./scripts/start-cluster.sh` starts three nodes and refreshes on a loop. Leave it running and the Console page shows what each node is doing.
- `bash tests/local_tests.sh` runs the backend tests.

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
