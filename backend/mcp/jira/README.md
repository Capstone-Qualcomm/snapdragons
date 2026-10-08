# Jira MCP adapter

`server.mjs` exposes the `list_assigned_jira_issues` tool over MCP stdio. It is a standalone developer/MCP-host adapter using an Atlassian API token from its private environment. The hosted dashboard does not use this process; it uses the per-browser OAuth integration in `backend/integrations/jira/`.

Configure these variables in the MCP host's private environment:

- `JIRA_BASE_URL` — Jira Cloud site URL, such as `https://example.atlassian.net`
- `JIRA_EMAIL` — Atlassian account email
- `JIRA_API_TOKEN` — Atlassian API token

Launch it from the repository root with:

```bash
node backend/mcp/jira/server.mjs
```

MCP host example:

```json
{
  "mcpServers": {
    "snapdragons-jira": {
      "command": "node",
      "args": ["backend/mcp/jira/server.mjs"],
      "env": {
        "JIRA_BASE_URL": "https://example.atlassian.net",
        "JIRA_EMAIL": "you@example.com",
        "JIRA_API_TOKEN": "set-this-in-your-private-MCP-config"
      }
    }
  }
}
```

Do not commit real API tokens. The public dashboard's Jira OAuth connection does not require users to provide API tokens.
