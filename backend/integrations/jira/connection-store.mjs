import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultStore = resolve(dirname(fileURLToPath(import.meta.url)), ".data/jira-connections.json");
const storePath = process.env.JIRA_CONNECTION_STORE ?? defaultStore;
let writeQueue = Promise.resolve();

function encryptionKey() {
  const value = process.env.JIRA_TOKEN_ENCRYPTION_KEY ?? "";
  if (!/^[a-f\d]{64}$/i.test(value)) {
    throw new Error("JIRA_TOKEN_ENCRYPTION_KEY must be a 32-byte hexadecimal key.");
  }
  return Buffer.from(value, "hex");
}

function encryptTokens(tokens) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), "utf8"), cipher.final()]);
  return { iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), data: encrypted.toString("hex") };
}

function decryptTokens(encrypted) {
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(encrypted.iv, "hex"));
  decipher.setAuthTag(Buffer.from(encrypted.tag, "hex"));
  const cleartext = Buffer.concat([decipher.update(Buffer.from(encrypted.data, "hex")), decipher.final()]);
  return JSON.parse(cleartext.toString("utf8"));
}

async function readAll() {
  try {
    return JSON.parse(await readFile(storePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function update(mutator) {
  const operation = writeQueue.then(async () => {
    const data = await readAll();
    const result = await mutator(data);
    await mkdir(dirname(storePath), { recursive: true });
    const temporaryPath = `${storePath}.${process.pid}.tmp`;
    await writeFile(temporaryPath, JSON.stringify(data), { mode: 0o600 });
    await rename(temporaryPath, storePath);
    return result;
  });
  writeQueue = operation.catch(() => {});
  return operation;
}

export async function readConnection(sessionId) {
  await writeQueue;
  const data = await readAll();
  const record = data[sessionId];
  if (!record) return null;
  return { ...record, tokens: decryptTokens(record.encryptedTokens) };
}

export function saveConnection(sessionId, connection) {
  return update((data) => {
    data[sessionId] = {
      enabled: connection.enabled ?? false,
      cloudId: connection.cloudId,
      sites: connection.sites,
      connectedAt: connection.connectedAt ?? new Date().toISOString(),
      encryptedTokens: encryptTokens(connection.tokens),
    };
  });
}

export function updateConnection(sessionId, fields) {
  return update((data) => {
    if (!data[sessionId]) return false;
    data[sessionId] = { ...data[sessionId], ...fields };
    return true;
  });
}

export function removeConnection(sessionId) {
  return update((data) => delete data[sessionId]);
}
