// A small Raft peer. Every node runs one, and the queue is the state machine
// they replicate. The Raft leader is called the orchestrator here and the
// followers are workers, since every node also runs steps. The orchestrator
// appends each change to its log and copies it to the other nodes; once a
// majority has it the change is committed and every node applies it in order. The transport, the clock and the storage
// are passed in, so tests can run a whole cluster in one process.

export type Command = { type: string; [key: string]: unknown };
export type Entry = { term: number; command: Command };
export type Role = "worker" | "candidate" | "orchestrator";

// Everything before index is folded into state, so the log does not grow forever.
export type Snapshot = { index: number; term: number; members: string[]; state: unknown };
export type Persisted = { term: number; votedFor: string | null; log: Entry[]; snapshot: Snapshot };

export type VoteRequest = { term: number; candidate: string; lastIndex: number; lastTerm: number };
export type VoteReply = { term: number; granted: boolean };
export type AppendRequest = {
  term: number;
  orchestrator: string;
  orchestratorCommit: number;
  // Either a run of entries after prevIndex, or a snapshot for a node that is too far behind.
  prevIndex?: number;
  prevTerm?: number;
  entries?: Entry[];
  snapshot?: Snapshot;
};
export type AppendReply = { term: number; success: boolean; conflictIndex?: number };

export type StateMachine = {
  apply(command: Command): unknown;
  save(): unknown;
  load(state: unknown): void;
};

type RaftOptions = {
  id: string;
  // The first members. Used only by a node starting with nothing saved.
  bootstrap?: string[];
  // Resolves with the other node's reply, a VoteReply or an AppendReply.
  send(to: string, type: "vote" | "append", body: VoteRequest | AppendRequest): Promise<unknown>;
  storage: { load(): Persisted | null; save(data: Persisted): void };
  machine: StateMachine;
  heartbeatMs?: number;
  electionMs?: [number, number];
  snapshotEvery?: number;
  now?: () => number;
  random?: () => number;
  // Called on the orchestrator once its own removal from the cluster is committed.
  onRemoved?: () => void;
};

export class NotOrchestrator extends Error {
  constructor(orchestrator: string | null) {
    super(orchestrator ? `${orchestrator} is the orchestrator.` : "There is no orchestrator right now.");
  }
}

export function createRaft(options: RaftOptions) {
  const { id, machine, storage, heartbeatMs = 300, electionMs = [1500, 3000], snapshotEvery = 300 } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const send = options.send as (to: string, type: "vote" | "append", body: VoteRequest | AppendRequest) => Promise<never>;

  // Saved to disk before answering anyone, so a node that restarts keeps its promises.
  const saved = storage.load();
  let term = saved?.term ?? 0;
  let votedFor = saved?.votedFor ?? null;
  let snapshot: Snapshot = saved?.snapshot ?? { index: 0, term: 0, members: [], state: null };
  // A new cluster starts with the same first entry on every member: who the members are.
  let log: Entry[] = saved?.log ?? (options.bootstrap?.includes(id) ? [{ term: 0, command: { type: "config", members: options.bootstrap } }] : []);
  if (snapshot.state !== null) machine.load(structuredClone(snapshot.state));
  if (!saved) persist();

  let commitIndex = snapshot.index;
  let lastApplied = snapshot.index;
  let role: Role = "worker";
  let orchestrator: string | null = null;
  let votes = new Set<string>();
  let electionAt = now() + electionTimeout();
  let heardFromOrchestratorAt = -Infinity;
  let heartbeatAt = 0;
  let removed = false;
  // Orchestrator only: the next entry to send each node, and the last one it is known to have.
  const nextIndex = new Map<string, number>();
  const matchIndex = new Map<string, number>();
  const inFlight = new Set<string>();
  // Clients waiting for their entry to be committed, by log index.
  const waiting = new Map<number, { term: number; resolve: (result: unknown) => void; reject: (cause: Error) => void }>();

  function persist(): void {
    storage.save({ term, votedFor, log, snapshot });
  }

  function electionTimeout(): number {
    const [min, max] = electionMs;
    return min + random() * (max - min);
  }

  const lastIndex = () => snapshot.index + log.length;
  const entryAt = (index: number) => log[index - snapshot.index - 1];
  const termAt = (index: number) => (index === snapshot.index ? snapshot.term : entryAt(index)?.term ?? 0);

  // The newest membership entry in the log counts as soon as it is appended, committed or not.
  function membersAt(index: number): string[] {
    for (let i = index; i > snapshot.index; i--) {
      const { command } = entryAt(i);
      if (command.type === "config") return command.members as string[];
    }
    return snapshot.members;
  }

  const members = () => membersAt(lastIndex());
  const others = () => members().filter((member) => member !== id);
  const majority = () => Math.floor(members().length / 2) + 1;

  function becomeWorker(newTerm: number): void {
    if (newTerm > term) {
      term = newTerm;
      votedFor = null;
      persist();
    }
    if (role === "orchestrator") {
      for (const waiter of waiting.values()) waiter.reject(new NotOrchestrator(null));
      waiting.clear();
    }
    if (role !== "worker") electionAt = now() + electionTimeout();
    role = "worker";
    votes = new Set();
  }

  function campaign(): void {
    role = "candidate";
    term += 1;
    votedFor = id;
    orchestrator = null;
    // A node its own log takes out of the members still asks for votes, since the change may need it to commit, but does not vote for itself.
    votes = new Set(members().includes(id) ? [id] : []);
    electionAt = now() + electionTimeout();
    persist();
    if (votes.size >= majority()) return becomeOrchestrator();
    const electionTerm = term;
    const request: VoteRequest = { term, candidate: id, lastIndex: lastIndex(), lastTerm: termAt(lastIndex()) };
    for (const peer of others()) {
      send(peer, "vote", request)
        .then((reply: VoteReply) => {
          if (reply.term > term) return becomeWorker(reply.term);
          if (role !== "candidate" || term !== electionTerm || !reply.granted) return;
          votes.add(peer);
          if (votes.size >= majority()) becomeOrchestrator();
        })
        .catch(() => {});
    }
  }

  function becomeOrchestrator(): void {
    role = "orchestrator";
    orchestrator = id;
    nextIndex.clear();
    matchIndex.clear();
    // An orchestrator can only commit entries from its own term by counting copies, so
    // it starts with an empty one. Committing it commits everything before it.
    append({ type: "noop", orchestrator: id, term, at: now() });
  }

  function append(command: Command): number {
    log.push({ term, command });
    persist();
    return lastIndex();
  }

  function replicateAll(): void {
    heartbeatAt = now() + heartbeatMs;
    for (const peer of others()) void replicate(peer);
    advanceCommit();
  }

  async function replicate(peer: string): Promise<void> {
    if (role !== "orchestrator" || inFlight.has(peer)) return;
    inFlight.add(peer);
    const sentTerm = term;
    const next = nextIndex.get(peer) ?? lastIndex() + 1;
    const request: AppendRequest =
      next <= snapshot.index
        ? { term, orchestrator: id, orchestratorCommit: commitIndex, snapshot }
        : { term, orchestrator: id, orchestratorCommit: commitIndex, prevIndex: next - 1, prevTerm: termAt(next - 1), entries: log.slice(next - snapshot.index - 1, next - snapshot.index + 99) };
    let more = false;
    try {
      const reply: AppendReply = await send(peer, "append", request);
      if (reply.term > term) return becomeWorker(reply.term);
      if (role !== "orchestrator" || term !== sentTerm) return;
      if (reply.success) {
        const match = request.snapshot ? request.snapshot.index : request.prevIndex! + request.entries!.length;
        matchIndex.set(peer, Math.max(match, matchIndex.get(peer) ?? 0));
        nextIndex.set(peer, match + 1);
        advanceCommit();
      } else {
        // That node's log does not line up here. Back up and try again.
        nextIndex.set(peer, Math.max(1, Math.min(reply.conflictIndex ?? next - 1, next - 1)));
      }
      more = (nextIndex.get(peer) ?? 0) <= lastIndex();
    } catch {
      // The node is down or cut off. The next heartbeat tries again.
    } finally {
      inFlight.delete(peer);
    }
    if (more) void replicate(peer);
  }

  function advanceCommit(): void {
    for (let index = lastIndex(); index > commitIndex && termAt(index) === term; index--) {
      const copies = members().filter((member) => member === id || (matchIndex.get(member) ?? 0) >= index).length;
      if (copies >= majority()) {
        commitIndex = index;
        applyCommitted();
        return;
      }
    }
  }

  function applyCommitted(): void {
    while (lastApplied < commitIndex) {
      lastApplied += 1;
      const entry = entryAt(lastApplied);
      const result = machine.apply(entry.command);
      const waiter = waiting.get(lastApplied);
      if (waiter) {
        waiting.delete(lastApplied);
        if (waiter.term === entry.term) waiter.resolve(result);
        else waiter.reject(new NotOrchestrator(orchestrator));
      }
    }
    if (role === "orchestrator" && !membersAt(commitIndex).includes(id)) {
      // This node's own removal is committed. It steps down and the rest elect a new orchestrator.
      role = "worker";
      removed = true;
      options.onRemoved?.();
    }
    if (lastApplied - snapshot.index >= snapshotEvery) {
      const dropped = lastApplied - snapshot.index;
      snapshot = { index: lastApplied, term: termAt(lastApplied), members: membersAt(lastApplied), state: machine.save() };
      log = log.slice(dropped);
      persist();
    }
  }

  function tick(): void {
    if (removed) return;
    if (role === "orchestrator") {
      if (now() >= heartbeatAt) replicateAll();
    } else if (now() >= electionAt && members().length) {
      campaign();
    }
  }

  function handleVote(request: VoteRequest): VoteReply {
    // The orchestrator, and a node that heard from it moments ago, ignore candidates, so a
    // node that was cut off or removed cannot unseat an orchestrator that is still working.
    if (role === "orchestrator" || now() - heardFromOrchestratorAt < electionMs[0]) return { term, granted: false };
    if (request.term > term) becomeWorker(request.term);
    const myLastTerm = termAt(lastIndex());
    // Only vote for a candidate whose log has everything this node has, so a new
    // orchestrator always has every committed entry.
    const upToDate = request.lastTerm > myLastTerm || (request.lastTerm === myLastTerm && request.lastIndex >= lastIndex());
    const granted = request.term === term && (votedFor === null || votedFor === request.candidate) && upToDate;
    if (granted) {
      votedFor = request.candidate;
      electionAt = now() + electionTimeout();
      persist();
    }
    return { term, granted };
  }

  function handleAppend(request: AppendRequest): AppendReply {
    if (request.term < term) return { term, success: false };
    if (request.term > term || role !== "worker") becomeWorker(request.term);
    orchestrator = request.orchestrator;
    heardFromOrchestratorAt = now();
    electionAt = now() + electionTimeout();

    if (request.snapshot) {
      const incoming = structuredClone(request.snapshot);
      if (incoming.index > lastApplied) {
        const keep = incoming.index <= lastIndex() && termAt(incoming.index) === incoming.term;
        log = keep ? log.slice(incoming.index - snapshot.index) : [];
        snapshot = incoming;
        machine.load(structuredClone(incoming.state));
        commitIndex = lastApplied = incoming.index;
        persist();
      }
      return { term, success: true };
    }

    const prevIndex = request.prevIndex!;
    if (prevIndex > lastIndex()) return { term, success: false, conflictIndex: lastIndex() + 1 };
    if (prevIndex > snapshot.index && termAt(prevIndex) !== request.prevTerm) {
      // Skip back over the whole term that disagrees instead of one entry per round trip.
      const badTerm = termAt(prevIndex);
      let first = prevIndex;
      while (first - 1 > snapshot.index && termAt(first - 1) === badTerm) first--;
      return { term, success: false, conflictIndex: first };
    }

    let index = prevIndex;
    let changed = false;
    for (const entry of request.entries!) {
      index += 1;
      if (index <= snapshot.index) continue;
      if (index <= lastIndex()) {
        if (termAt(index) === entry.term) continue;
        // Entries this node got from an old orchestrator that never committed them. Drop them.
        log = log.slice(0, index - snapshot.index - 1);
      }
      log.push(entry);
      changed = true;
    }
    if (changed) persist();
    if (request.orchestratorCommit > commitIndex) {
      commitIndex = Math.min(request.orchestratorCommit, index);
      applyCommitted();
    }
    return { term, success: true };
  }

  // Appends a command and resolves with the state machine's answer once it is committed.
  function submit(command: Command): Promise<unknown> {
    if (role !== "orchestrator") return Promise.reject(new NotOrchestrator(orchestrator));
    const index = append(command);
    const result = new Promise<unknown>((resolve, reject) => waiting.set(index, { term, resolve, reject }));
    replicateAll();
    return result;
  }

  // Adds or removes one node. One change at a time, and only once this orchestrator has
  // committed something in its own term, so two majorities can never disagree.
  function changeMembers(change: { add?: string; remove?: string }): Promise<unknown> {
    if (role !== "orchestrator") return Promise.reject(new NotOrchestrator(orchestrator));
    const pending = log.some((entry, offset) => entry.command.type === "config" && snapshot.index + offset + 1 > commitIndex);
    if (pending || termAt(commitIndex) !== term) return Promise.reject(new Error("Another membership change is in progress."));
    const current = members();
    const next = change.add ? [...new Set([...current, change.add])].sort() : current.filter((member) => member !== change.remove);
    if (next.length === current.length) return Promise.resolve(null);
    // With no members left nothing could ever commit, this change included.
    if (!next.length) return Promise.reject(new Error("The last node cannot be removed."));
    return submit({ type: "config", members: next, at: now() });
  }

  function status() {
    return {
      id,
      role,
      term,
      orchestrator,
      votedFor,
      votes: [...votes],
      members: members(),
      commitIndex,
      lastIndex: lastIndex(),
      snapshotIndex: snapshot.index,
      // How long until this node gives up waiting and asks for votes, and how long since it last heard from an orchestrator.
      electionIn: Math.max(0, Math.round(electionAt - now())),
      quietFor: Number.isFinite(heardFromOrchestratorAt) ? Math.round(now() - heardFromOrchestratorAt) : null,
    };
  }

  return { tick, handleVote, handleAppend, submit, changeMembers, status, isOrchestrator: () => role === "orchestrator" };
}

export type Raft = ReturnType<typeof createRaft>;
