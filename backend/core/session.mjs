import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const sessionCookie = "continuum_session";
const sessionLifetime = 30 * 24 * 60 * 60;

function sessionSecret() {
  const value = process.env.APP_SESSION_SECRET ?? "";
  if (Buffer.byteLength(value) < 32) throw new Error("APP_SESSION_SECRET must contain at least 32 characters.");
  return value;
}

function sign(value) {
  return createHmac("sha256", sessionSecret()).update(value).digest("base64url");
}

export function readSession(request) {
  const cookie = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${sessionCookie}=`));
  if (!cookie) return null;
  const value = decodeURIComponent(cookie.slice(sessionCookie.length + 1));
  const [id, expiresAt, signature] = value.split(".");
  if (!id || !expiresAt || !signature || Number(expiresAt) < Date.now()) return null;
  const payload = `${id}.${expiresAt}`;
  const expected = Buffer.from(sign(payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return id;
}

export function getOrCreateSession(request, response) {
  const existing = readSession(request);
  if (existing) return existing;
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = Date.now() + sessionLifetime * 1000;
  const payload = `${sessionId}.${expiresAt}`;
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  response.setHeader("Set-Cookie", `${sessionCookie}=${encodeURIComponent(`${payload}.${sign(payload)}`)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionLifetime}${secure}`);
  return sessionId;
}
