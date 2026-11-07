import { describe, expect, it } from "vitest";
import { describeEvent } from "./cluster";
import type { Task } from "./cluster";

const tasks = [{ id: "T-5", input: "Rank today's list" }] as Task[];

describe("describeEvent", () => {
  it("turns the cluster's log into plain sentences with board names", () => {
    expect(describeEvent("Q-01 resumed T-4 (Fetch Slack messages) at 40%, lost by Q-03", tasks)).toBe("Orchestrator gave Board 3's “Fetch Slack messages” to Board 1 at 40%");
    expect(describeEvent("Q-02 claimed T-4 (Fetch Slack messages)", tasks)).toBe("Board 2 started “Fetch Slack messages”");
    expect(describeEvent("Q-02 completed T-5", tasks)).toBe("Board 2 finished “Rank today's list”");
    expect(describeEvent("Q-02 completed T-9", tasks)).toBe("Board 2 finished “a step”");
    expect(describeEvent("J-15 done in 6.6 s on 3 nodes", tasks)).toBe("Refresh finished in 6.6 s on 3 boards");
    expect(describeEvent("J-16 Morning refresh queued as 4 steps", tasks)).toBe("Refresh queued as 4 steps");
    expect(describeEvent("Q-04 elected orchestrator for term 2", tasks)).toBe("Board 4 was elected orchestrator");
    expect(describeEvent("Q-03 joined", tasks)).toBe("Board 3 joined");
    expect(describeEvent("Plan J-7 done in 18.2 s on 4 nodes", tasks)).toBe("Job finished in 18.2 s on 4 boards");
  });

  it("says what a finished fetch loaded, and nothing more for a step without a source", () => {
    const fetched = [
      { id: "T-2", input: "Fetch Slack messages", source: "slack", output: { summary: "Loaded 12 Slack messages", short: "12 messages", data: null } },
      { id: "T-3", input: "Fetch Jira tickets", source: "jira" },
      { id: "T-4", input: "Draft replies", skill: "draft", output: { summary: "3 replies drafted", short: "3 replies", data: null } },
    ] as Task[];
    expect(describeEvent("Q-02 completed T-2", fetched)).toBe("Board 2 finished “Fetch Slack messages”: Loaded 12 Slack messages");
    // A fetch whose result has not reached this page yet, and an Assistant step, read as before.
    expect(describeEvent("Q-01 completed T-3", fetched)).toBe("Board 1 finished “Fetch Jira tickets”");
    expect(describeEvent("Q-03 completed T-4", fetched)).toBe("Board 3 finished “Draft replies”");
  });
});
