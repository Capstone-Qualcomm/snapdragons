#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
(cd "$ROOT/backend" && node --test source-activity.test.mts sessions.test.mts)
for dir in jira slack github cluster; do
  (cd "$ROOT/backend/$dir" && npm test --silent)
done
(cd "$ROOT" && node --test tests/deploy.test.ts tests/integration/cluster.test.ts tests/integration/slack.test.ts)
(cd "$ROOT/frontend" && npm test --silent)
