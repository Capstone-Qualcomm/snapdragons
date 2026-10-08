# Backend

The backend keeps its entry point at the root, shared runtime code in `core/`, and groups provider-specific code by responsibility:

- `core/` contains shared HTTP helpers and browser session handling.
- `integrations/<provider>/` contains app authorization, API access, and provider connection state. Jira is in `integrations/jira/`.
- `mcp/<provider>/` contains the MCP adapter for a provider. Jira's stdio MCP server is in `mcp/jira/`.
- `server.mjs` is the HTTP entry point and delegates provider routes to the integration router.

This layout leaves Slack and GitHub integrations independent while allowing each to expose its own MCP adapter.

For the Jira dashboard OAuth setup and hosting instructions, see [integrations/jira/README.md](integrations/jira/README.md). To run the standalone Jira MCP adapter, see [mcp/jira/README.md](mcp/jira/README.md).
