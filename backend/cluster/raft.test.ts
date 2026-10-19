import assert from "node:assert/strict";
import { test } from "node:test";
import { createQueue } from "./queue.ts";
import { createRaft } from "./raft.ts";
import type { Persisted, Raft } from "./raft.ts";

// A whole cluster in one process: a clock the test moves by hand, a network
// that can drop a node, and storage that survives a node being restarted.
function testCluster(ids: string[], { snapshotEvery = 300 } = {}) {
  let time = 0;
  const nodes = new Map<string, { raft: Raft; queue: ReturnType<typeof createQueue> }>();
  const disks = new Map<string, Persisted>();
  const cutOff = new Set<string>();

  function start(id: string, bootstrap: string[] | undefined = ids) {
    const queue = createQueue();
    const raft = createRaft({
      id,
      bootstrap,
      machine: queue,
      snapshotEvery,
      now: () => time,
      storage: { load: () => structuredClone(disks.get(id) ?? null), save: (data) => disks.set(id, structuredClone(data)) },
      send: async (to, type, body) => {
        const target = nodes.get(to);
        if (!target || cutOff.has(id) || cutOff.has(to)) throw new Error("unreachable");
        const reply = type === "vote" ? target.raft.handleVote(structuredClone(body) as never) : target.raft.handleAppend(structuredClone(body) as never);
        return structuredClone(reply);
      },
    });
    nodes.set(id, { raft, queue });
    return raft;
  }

  // Each 50 ms step ticks every node, then lets the replies land.
  async function run(ms: number, each?: () => void) {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      time += 50;
      for (const { raft } of nodes.values()) raft.tick();
      await new Promise((resolve) => setImmediate(resolve));
      each?.();
    }
  }

  function orchestrator(): Raft | undefined {
    return [...nodes.entries()]
      .filter(([id, { raft }]) => !cutOff.has(id) && raft.isOrchestrator())
      .map(([, { raft }]) => raft)
      .sort((a, b) => b.status().term - a.status().term)[0];
  }

  async function elect(): Promise<Raft> {
    for (let attempt = 0; attempt < 100 && !orchestrator(); attempt++) await run(100);
    assert.ok(orchestrator(), "no orchestrator was elected");
    return orchestrator()!;
  }

  for (const id of ids) start(id);
  return { nodes, disks, cutOff, start, run, orchestrator, elect, kill: (id: string) => nodes.delete(id), at: () => time };
}

const job = (name: string) => ({ type: "job", name, steps: ["a", "b"], at: 0 });
const jobNames = (queue: ReturnType<typeof createQueue>) => queue.state().jobs.map((entry) => entry.name);

test("one orchestrator per term, and the others follow it", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestratorsByTerm = new Map<number, Set<string>>();
  await cluster.run(8000, () => {
    for (const { raft } of cluster.nodes.values()) {
      const { role, term, id } = raft.status();
      if (role === "orchestrator") orchestratorsByTerm.set(term, (orchestratorsByTerm.get(term) ?? new Set()).add(id));
    }
  });

  assert.ok(orchestratorsByTerm.size >= 1);
  for (const orchestrators of orchestratorsByTerm.values()) assert.equal(orchestrators.size, 1);
  const orchestrator = cluster.orchestrator()!.status();
  for (const { raft } of cluster.nodes.values()) assert.equal(raft.status().orchestrator, orchestrator.id);
});

test("a command resolves once a majority has it, and every node applies it", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestrator = await cluster.elect();
  const result = orchestrator.submit(job("refresh"));
  await cluster.run(400);

  assert.equal(((await result) as { name: string }).name, "refresh");
  for (const { queue } of cluster.nodes.values()) assert.deepEqual(jobNames(queue), ["refresh"]);
});

test("nothing commits without a majority", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestrator = await cluster.elect();
  for (const { raft } of cluster.nodes.values()) if (raft !== orchestrator) cluster.cutOff.add(raft.status().id);
  let committed = false;
  orchestrator.submit(job("lonely")).then(() => (committed = true), () => {});
  await cluster.run(1000);

  assert.equal(committed, false);
  assert.equal(orchestrator.status().commitIndex < orchestrator.status().lastIndex, true);
});

test("a node with an out-of-date log cannot become orchestrator", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const first = await cluster.elect();
  const [behind, other] = ["Q-01", "Q-02", "Q-03"].filter((id) => id !== first.status().id);
  cluster.cutOff.add(behind);
  const result = first.submit(job("only on two"));
  await cluster.run(400);
  await result;

  // The orchestrator dies and the node that missed the entry comes back. Only the
  // node that has the entry can win, because the other will not vote for a shorter log.
  cluster.kill(first.status().id);
  cluster.cutOff.delete(behind);
  const second = await cluster.elect();
  assert.equal(second.status().id, other);
  await cluster.run(500);
  assert.deepEqual(jobNames(cluster.nodes.get(behind)!.queue), ["only on two"]);
});

test("the vote check compares the last term first, then length", () => {
  const raft = createRaft({
    id: "Q-01",
    bootstrap: ["Q-01", "Q-02"],
    machine: createQueue(),
    storage: { load: () => null, save: () => {} },
    send: async () => ({}),
  });
  // Q-01 has one entry from term 0.
  assert.equal(raft.handleVote({ term: 1, candidate: "Q-02", lastIndex: 0, lastTerm: 0 }).granted, false);
  assert.equal(raft.handleVote({ term: 1, candidate: "Q-02", lastIndex: 1, lastTerm: 0 }).granted, true);
  // Already voted in term 1.
  assert.equal(raft.handleVote({ term: 1, candidate: "Q-03", lastIndex: 5, lastTerm: 0 }).granted, false);
});

test("a node that falls behind is brought up to date", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestrator = await cluster.elect();
  const behind = ["Q-01", "Q-02", "Q-03"].find((id) => id !== orchestrator.status().id)!;
  cluster.cutOff.add(behind);
  for (let n = 1; n <= 5; n++) void orchestrator.submit(job(`refresh ${n}`));
  await cluster.run(500);
  assert.deepEqual(jobNames(cluster.nodes.get(behind)!.queue), []);

  cluster.cutOff.delete(behind);
  await cluster.run(1000);
  assert.equal(cluster.nodes.get(behind)!.raft.status().lastIndex, orchestrator.status().lastIndex);
  assert.equal(jobNames(cluster.nodes.get(behind)!.queue).length, 5);
});

test("entries an old orchestrator never committed are replaced by the new orchestrator's", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const old = await cluster.elect();
  const oldId = old.status().id;
  cluster.cutOff.add(oldId);
  void old.submit(job("never committed")).catch(() => {});
  const fresh = await cluster.elect();
  assert.notEqual(fresh.status().id, oldId);
  const result = fresh.submit(job("committed"));
  await cluster.run(400);
  await result;

  cluster.cutOff.delete(oldId);
  await cluster.run(1000);
  assert.equal(old.isOrchestrator(), false);
  assert.deepEqual(jobNames(cluster.nodes.get(oldId)!.queue), ["committed"]);
});

test("committed work survives the orchestrator dying", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const first = await cluster.elect();
  const result = first.submit(job("refresh"));
  await cluster.run(400);
  await result;

  cluster.kill(first.status().id);
  const second = await cluster.elect();
  const queue = cluster.nodes.get(second.status().id)!.queue;
  assert.deepEqual(jobNames(queue), ["refresh"]);
  assert.equal(queue.state().tasks.length, 2);
});

test("the whole cluster restarts from what each node saved", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestrator = await cluster.elect();
  const result = orchestrator.submit(job("before the restart"));
  await cluster.run(400);
  await result;
  const term = orchestrator.status().term;

  for (const id of ["Q-01", "Q-02", "Q-03"]) cluster.kill(id);
  for (const id of ["Q-01", "Q-02", "Q-03"]) cluster.start(id);
  const next = await cluster.elect();
  await cluster.run(500);

  assert.ok(next.status().term > term);
  for (const { queue } of cluster.nodes.values()) assert.deepEqual(jobNames(queue), ["before the restart"]);
});

test("a node is added and removed through the log, one change at a time", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"]);
  const orchestrator = await cluster.elect();
  await cluster.run(300);
  cluster.start("Q-04", undefined);

  const adding = orchestrator.changeMembers({ add: "Q-04" });
  await assert.rejects(orchestrator.changeMembers({ add: "Q-05" }), /Another membership change/);
  await cluster.run(500);
  await adding;
  assert.deepEqual(orchestrator.status().members, ["Q-01", "Q-02", "Q-03", "Q-04"]);
  assert.deepEqual(cluster.nodes.get("Q-04")!.raft.status().members, ["Q-01", "Q-02", "Q-03", "Q-04"]);

  // The orchestrator removes itself: once that commits it steps down and the rest elect a new one.
  const oldId = orchestrator.status().id;
  const removing = orchestrator.changeMembers({ remove: oldId });
  await cluster.run(500);
  await removing;
  assert.equal(orchestrator.isOrchestrator(), false);
  cluster.kill(oldId);
  const next = await cluster.elect();
  assert.equal(next.status().members.includes(oldId), false);
  assert.equal(next.status().members.length, 3);
});

test("a node too far behind gets a snapshot instead of the whole log", async () => {
  const cluster = testCluster(["Q-01", "Q-02", "Q-03"], { snapshotEvery: 5 });
  const orchestrator = await cluster.elect();
  const behind = ["Q-01", "Q-02", "Q-03"].find((id) => id !== orchestrator.status().id)!;
  cluster.cutOff.add(behind);
  for (let n = 1; n <= 12; n++) void orchestrator.submit(job(`refresh ${n}`));
  await cluster.run(500);
  assert.ok(cluster.disks.get(orchestrator.status().id)!.snapshot.index > 0);

  cluster.cutOff.delete(behind);
  await cluster.run(1000);
  assert.equal(jobNames(cluster.nodes.get(behind)!.queue).length, 12);
  assert.equal(cluster.nodes.get(behind)!.raft.status().lastIndex, orchestrator.status().lastIndex);
});
