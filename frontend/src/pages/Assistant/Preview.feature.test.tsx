import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { Task } from "../Cluster/cluster";
import { Preview } from "./Preview";

const inbox = (fields: Record<string, unknown>) => ({
  id: "T-1", input: "", status: "claimed", worker: "Q-02", lostBy: [], job: "J-1", after: [], progress: 0, runs: [],
  preview: { kind: "list", look: "inbox", rows: Array.from({ length: 40 }, (_, row) => [`Sender ${row + 1}`, `Subject ${row + 1}`]) },
  found: { marks: [[6, "Northwind · interview"], [28, "Halcyon · no"]], chips: ["northwind-robotics.example"] },
  ...fields,
}) as unknown as Task;

afterEach(cleanup);

describe("Preview", () => {
  it("tags a match only once the scan has passed it, and shows the links it pulled out at the end", () => {
    const { container, rerender } = render(<Preview task={inbox({})} progress={0.5} />);
    expect([...container.querySelectorAll(".row-tag")].map((tag) => tag.textContent)).toEqual(["✓ Northwind · interview"]);
    expect(container.querySelector(".is-now")?.textContent).toContain("Sender 21");
    expect(container.querySelector(".link-chip")).toBeNull();
    rerender(<Preview task={inbox({ status: "done" })} progress={1} />);
    expect(container.querySelectorAll(".row-tag")).toHaveLength(2);
    expect(container.querySelector(".link-chip")?.textContent).toBe("northwind-robotics.example");
  });

  it("lights up open calendar slots one by one, and freezes a dead board's sketch", () => {
    const week = { kind: "calendar", days: ["Mon", "Tue"], busy: [[0, 570, 645]] };
    const task = inbox({ preview: week, found: { slots: [[0, 660, 735], [1, 540, 660]] } });
    const { container } = render(<Preview task={task} progress={0.5} frozen />);
    expect(container.querySelectorAll(".slot")).toHaveLength(1);
    expect(container.querySelector(".preview-bar .num")?.textContent).toBe("Mon 11:00");
    expect(container.querySelector(".preview")?.className).toContain("is-frozen");
  });
});
