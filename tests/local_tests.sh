#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
JIRA_BACKEND_DIR="$SCRIPT_DIR/../backend/jira"
GITHUB_BACKEND_DIR="$SCRIPT_DIR/../backend/github"
(cd "$JIRA_BACKEND_DIR" && node --test server.test.ts)
(cd "$GITHUB_BACKEND_DIR" && node --test)
(cd "$SCRIPT_DIR/../backend/cluster" && node --test)
(cd "$SCRIPT_DIR/.." && node --test tests/integration/cluster.test.ts tests/integration/slack.test.ts)
