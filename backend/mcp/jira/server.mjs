import { createInterface } from "node:readline";
import { getAssignedIssues } from "./jira.mjs";

const protocolVersion = "2025-03-26";

function reply(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on("line", async (line) => {
  let message;
  try {
    message = JSON.parse(line);
    if (message.method === "initialize") {
      reply({ jsonrpc: "2.0", id: message.id, result: { protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "snapdragons-jira", version: "1.0.0" } } });
    } else if (message.method === "notifications/initialized") {
      // MCP notifications do not receive a response.
    } else if (message.method === "ping") {
      reply({ jsonrpc: "2.0", id: message.id, result: {} });
    } else if (message.method === "tools/list") {
      reply({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{
            name: "list_assigned_jira_issues",
            description: "List Jira issues assigned to the authenticated Jira user, sorted by most recently updated.",
            inputSchema: { type: "object", properties: {}, additionalProperties: false },
          }],
        },
      });
    } else if (message.method === "tools/call" && message.params?.name === "list_assigned_jira_issues") {
      const issues = await getAssignedIssues();
      reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: JSON.stringify(issues, null, 2) }], structuredContent: { issues }, isError: false } });
    } else if (message.id !== undefined) {
      reply({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
    }
  } catch (error) {
    if (message?.id !== undefined) {
      reply({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "Jira request failed" }], isError: true } });
    }
  }
});
