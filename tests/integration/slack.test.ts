import { test } from "node:test";
import assert from "node:assert/strict";
import { createSlackApi } from "../../backend/slack/slack-api.ts";

const noopConnection = { connected: false, enabled: false, connectedAt: null, userId: null, team: null, token: null };
const api = createSlackApi({ slackConnection: noopConnection, fetchImpl: fetch });

test("cleanText turns Slack markup into readable text", () => {
  assert.equal(api.cleanText("<@U1> can you check <#C9|standup> and <https://x.com/doc|the doc>? &lt;3 <https://y.com>", { U1: "you" }), "@you can you check #standup and the doc? <3 https://y.com");
  assert.equal(api.cleanText("<@U2|sam> hi"), "@sam hi");
  assert.equal(api.cleanText("<@U3> hi"), "@someone hi");
  assert.equal(api.cleanText(undefined), "");
});

test("needsReply only flags recent DMs where the other person spoke last", () => {
  const since = 1000;
  assert.equal(api.needsReply({ user: "THEM", ts: "1500.1" }, "ME", since), true);
  assert.equal(api.needsReply({ user: "ME", ts: "1500.1" }, "ME", since), false);
  assert.equal(api.needsReply({ user: "THEM", ts: "900.1" }, "ME", since), false);
  assert.equal(api.needsReply({ user: "THEM", ts: "1500.1", subtype: "channel_join" }, "ME", since), false);
  assert.equal(api.needsReply(undefined, "ME", since), false);
});

test("toItem builds a stable id and ISO time", () => {
  const item = api.toItem({ kind: "dm", channel: "D1", where: "Direct message", from: "Matthew", text: "<@ME> ping", ts: "1760000000.000100", url: "https://slack.com/x" }, { ME: "you" });
  assert.equal(item.id, "D1:1760000000.000100");
  assert.equal(item.text, "@you ping");
  assert.equal(item.sentAt, "2025-10-09T08:53:20.000Z");
});
test("an expired, revoked or missing Slack token asks the user to reconnect", async () => {
  for (const error of ["invalid_auth", "token_revoked", "token_expired", "not_authed"]) {
    const connected = { ...noopConnection, connected: true, token: { accessToken: "xoxp-test" } } as unknown as typeof noopConnection;
    const slack = createSlackApi({ slackConnection: connected, fetchImpl: async () => Response.json({ ok: false, error }) });
    await assert.rejects(slack.getMessages(), /Reconnect Slack/, error);
  }
});

test("a DM Slack won't read is skipped, and the other DMs and mentions still load", async () => {
  const now = String(Date.now() / 1000);
  const replies: Record<string, unknown> = {
    "auth.test": { ok: true },
    "search.messages": { ok: true, messages: { matches: [{ user: "U2", ts: now, text: "<@ME> ping", channel: { id: "C1", name: "dev" }, username: "Jordan" }] } },
    "conversations.list": { ok: true, channels: [{ id: "D1", user: "U1" }, { id: "D2", user: "U3" }, { id: "D3", user: "U4", is_user_deleted: true }] },
    "users.info": { ok: true, user: { real_name: "Priya" } },
    "chat.getPermalink": { ok: true, permalink: "https://slack.com/p" },
  };
  const connected = { ...noopConnection, connected: true, userId: "ME", token: { accessToken: "xoxp-test" } } as unknown as typeof noopConnection;
  const slack = createSlackApi({
    slackConnection: connected,
    fetchImpl: async (input) => {
      const url = new URL(String(input));
      const method = url.pathname.replace("/api/", "");
      if (method === "conversations.history") {
        if (url.searchParams.get("channel") === "D2") return Response.json({ ok: false, error: "ratelimited" });
        return Response.json({ ok: true, messages: [{ user: "U1", ts: now, text: "got a sec?" }] });
      }
      return Response.json(replies[method]);
    },
  });

  const messages = await slack.getMessages();
  assert.deepEqual(messages.map((message) => [message.kind, message.from]).sort(), [["dm", "Priya"], ["mention", "Jordan"]]);
});
