import assert from "node:assert/strict";
import { createVerify, generateKeyPairSync } from "node:crypto";
import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, test } from "node:test";
import { complete } from "./llm.ts";
import { createClusterServer } from "./server.ts";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});
const servers = new Set<Server>();
const saved = { ...process.env };
const ask = (maxTokens = 50) => complete([{ role: "user", content: "hi" }], maxTokens);

async function listen(server: Server): Promise<string> {
  servers.add(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const read = async (req: AsyncIterable<unknown>) => {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
};

// Fake token and model servers, with a service account pointing at them. A new token_uri each time means a cold cache.
async function gcp({ expiresIn = 3599, tokenStatus = 200, reply = "hello" } = {}) {
  const calls = { tokens: 0, models: [] as Array<{ url?: string; authorization?: string; model: string; max_tokens: number }>, assertion: "", aud: "" };
  const tokenServer = createServer(async (req, res) => {
    const params = new URLSearchParams(await read(req));
    calls.tokens++;
    calls.assertion = params.get("assertion") ?? "";
    assert.equal(params.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
    // Slow enough that concurrent callers all arrive before this answers.
    await new Promise((resolve) => setTimeout(resolve, 20));
    res.statusCode = tokenStatus;
    res.end(JSON.stringify(tokenStatus === 200 ? { access_token: `token-${calls.tokens}`, expires_in: expiresIn } : { error: "invalid_grant" }));
  });
  const modelServer = createServer(async (req, res) => {
    const body = JSON.parse(await read(req));
    calls.models.push({ url: req.url, authorization: req.headers.authorization, ...body });
    if (body.stream) return void res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: reply } }] })}\n\ndata: [DONE]\n\n`);
    res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
  });
  const tokenUri = await listen(tokenServer);
  const key = Buffer.from(JSON.stringify({ client_email: "sa@test", private_key: privateKey, token_uri: tokenUri })).toString("base64");
  process.env.GCP_AI_ENDPOINT = `${await listen(modelServer)}/v1/`;
  process.env.GCP_AI_KEY = key;
  process.env.GCP_AI_MODEL = "test-model";
  return { calls, key, tokenUri };
}

afterEach(() => {
  for (const server of servers) server.close();
  servers.clear();
  for (const name of ["GCP_AI_ENDPOINT", "GCP_AI_KEY", "GCP_AI_MODEL", "GCP_AI_ARMOR"]) {
    if (saved[name] === undefined) delete process.env[name];
    else process.env[name] = saved[name];
  }
});

test("a completion signs in with the service account and sends the model its token, and a second call reuses it", async () => {
  const { calls, tokenUri } = await gcp();
  assert.equal(await ask(), "hello");
  assert.equal(await ask(), "hello");

  assert.equal(calls.tokens, 1);
  assert.deepEqual(calls.models.map((call) => call.authorization), ["Bearer token-1", "Bearer token-1"]);
  assert.equal(calls.models[0].url, "/v1/chat/completions");
  assert.equal(calls.models[0].model, "test-model");
  assert.equal(calls.models[0].max_tokens, 50);

  const [header, claims, signature] = calls.assertion.split(".");
  assert.ok(createVerify("RSA-SHA256").update(`${header}.${claims}`).verify(publicKey, signature, "base64url"), "the request is signed by the account's key");
  const decoded = JSON.parse(Buffer.from(claims, "base64url").toString());
  assert.equal(decoded.iss, "sa@test");
  assert.equal(decoded.aud, tokenUri);
  assert.equal(decoded.scope, "https://www.googleapis.com/auth/cloud-platform");
});

test("a token within a minute of expiring is replaced", async () => {
  const { calls } = await gcp({ expiresIn: 30 });
  await ask();
  await ask();
  assert.equal(calls.tokens, 2);
  assert.deepEqual(calls.models.map((call) => call.authorization), ["Bearer token-1", "Bearer token-2"]);
});

test("concurrent calls share one token request", async () => {
  const { calls } = await gcp();
  await Promise.all([ask(), ask(), ask()]);
  assert.equal(calls.tokens, 1);
  assert.equal(calls.models.length, 3);
});

test("token failures say what went wrong without quoting the key", async () => {
  const { calls, key } = await gcp({ tokenStatus: 400 });
  const clean = (error: Error) => !error.message.includes("PRIVATE KEY") && !error.message.includes(key) && !error.message.includes(calls.assertion || "no assertion");
  await assert.rejects(ask(), (error: Error) => /GCP refused the model token \(HTTP 400\)/.test(error.message) && clean(error));
  assert.equal(calls.models.length, 0);

  // A failed refresh isn't remembered, and a broken key is reported as such.
  await assert.rejects(ask(), /HTTP 400/);
  assert.equal(calls.tokens, 2);
  process.env.GCP_AI_KEY = Buffer.from("not json").toString("base64");
  await assert.rejects(ask(), /not a usable base64-encoded service account JSON/);
  process.env.GCP_AI_KEY = Buffer.from(JSON.stringify({ client_email: "sa@test", private_key: "garbage", token_uri: "http://127.0.0.1:1" })).toString("base64");
  await assert.rejects(ask(), (error: Error) => /not a usable/.test(error.message) && !error.message.includes("garbage"));
});

// A fake Model Armor template that flags any text containing "bad".
async function armor(status = 200, state?: string) {
  const checks: Array<{ url?: string; authorization?: string; body: Record<string, { text: string }> }> = [];
  const server = createServer(async (req, res) => {
    const body = JSON.parse(await read(req));
    checks.push({ url: req.url, authorization: req.headers.authorization, body });
    const { text } = (body.userPromptData ?? body.modelResponseData) as { text: string };
    res.statusCode = status;
    res.end(JSON.stringify({ sanitizationResult: { filterMatchState: state ?? (text.includes("bad") ? "MATCH_FOUND" : "NO_MATCH_FOUND") } }));
  });
  process.env.GCP_AI_ARMOR = `${await listen(server)}/v1/templates/test/`;
  return checks;
}

test("Model Armor checks the prompt without the system message, then the reply", async () => {
  await gcp();
  const checks = await armor();
  assert.equal(await complete([{ role: "system", content: "bad but ours" }, { role: "user", content: "first" }, { role: "assistant", content: "second" }]), "hello");
  assert.deepEqual(checks.map((check) => check.url), ["/v1/templates/test:sanitizeUserPrompt", "/v1/templates/test:sanitizeModelResponse"]);
  assert.deepEqual(checks[0].body, { userPromptData: { text: "first\n\nsecond" } });
  assert.deepEqual(checks[1].body, { modelResponseData: { text: "hello" } });
  assert.equal(checks[0].authorization, "Bearer token-1");
});

test("a flagged prompt never reaches the model, and the error does not quote it", async () => {
  const { calls } = await gcp();
  await armor();
  await assert.rejects(complete([{ role: "user", content: "bad secret" }]), (error: Error) => error.message === "Model Armor blocked the prompt.");
  assert.equal(calls.models.length, 0);
});

test("a flagged reply is not returned", async () => {
  await gcp({ reply: "bad reply" });
  await armor();
  await assert.rejects(ask(), (error: Error) => error.message === "Model Armor blocked the reply.");
});

test("if Model Armor can't answer, the model isn't called", async () => {
  const { calls } = await gcp();
  await armor(500);
  await assert.rejects(ask(), /Model Armor could not check the prompt \(HTTP 500\)/);
  await armor(200, "FILTER_MATCH_STATE_UNSPECIFIED");
  await assert.rejects(ask(), /Model Armor could not check the prompt\./);
  assert.equal(calls.models.length, 0);
});

test("without a template, nothing is sent to Model Armor", async () => {
  await gcp();
  assert.equal(await ask(), "hello");
});

test("a streamed reply flagged at the end fails, and the gateway cuts the board's stream so it fails there too", async () => {
  await gcp({ reply: "bad reply" });
  await armor();
  const shown: string[] = [];
  await assert.rejects(complete([{ role: "user", content: "hi" }], 50, (text) => shown.push(text)), /Model Armor blocked the reply/);
  assert.deepEqual(shown, ["bad reply"]);

  const { server, servicesServer } = createClusterServer({ port: 0 });
  servers.add(server);
  const gateway = await listen(servicesServer);
  const response = await fetch(`${gateway}/llm`, { method: "POST", body: JSON.stringify({ messages: [{ role: "user", content: "hi" }], stream: true }) });
  assert.equal(response.status, 200);
  await assert.rejects(response.text());
});
