import assert from "node:assert/strict";
import { test } from "node:test";
import { createSourceActivity } from "./source-activity.mts";

test("sync history keeps the newest 50 status and count records", () => {
  const activity = createSourceActivity();
  for (let count = 0; count < 51; count++) activity.add(200, count);

  const events = activity.list();
  assert.equal(events.length, 50);
  assert.deepEqual({ status: events[0].status, count: events[0].count }, { status: 200, count: 50 });
  assert.equal(events.at(-1)?.count, 1);
  assert.ok(Number.isFinite(Date.parse(events[0].timestamp)));
});

test("failed syncs have no item count", () => {
  const activity = createSourceActivity();
  activity.add(502);
  assert.equal(activity.list()[0].count, null);
});
