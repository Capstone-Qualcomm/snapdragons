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