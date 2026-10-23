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
});
