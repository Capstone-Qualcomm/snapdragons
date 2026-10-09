import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createConnectionStore } from "../../core/connection-store.mjs";

const defaultStore = resolve(dirname(fileURLToPath(import.meta.url)), ".data/jira-connections.json");

export const { readConnection, saveConnection, updateConnection, removeConnection } = createConnectionStore(process.env.JIRA_CONNECTION_STORE ?? defaultStore, "JIRA_TOKEN_ENCRYPTION_KEY");
