#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
JIRA_BACKEND_DIR="$SCRIPT_DIR/../backend/jira"
(cd "$JIRA_BACKEND_DIR" && node --test server.test.ts)
