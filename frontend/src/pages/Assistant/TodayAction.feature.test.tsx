import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TodayAction } from "./TodayAction";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function setup(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", vi.fn(fetcher));
  render(<TodayAction initialRequest="Set QT1S-31 to Done" sources={[]} />);
}

describe("Assistant Today action", () => {
  it("prepares a Jira status proposal, loads transitions, and confirms only after review", async () => {
    const calls: string[] = [];
    setup(async (input) => {
      const path = String(input); calls.push(path);
      if (path.endsWith("/api/assistant/action/prepare")) {
        return calls.filter((call) => call === path).length === 1
          ? Response.json({ ready: true, source: "jira", itemId: "QT1S-31", todayId: "jira:QT1S-31@0", title: "Fix queue", action: "status" })
          : Response.json({ ready: true, source: "jira", itemId: "QT1S-31", todayId: "jira:QT1S-31@0", title: "Fix queue", action: "status", value: "Done" });
      }
      if (path.endsWith("/transitions")) return Response.json({ transitions: [{ id: "41", name: "Finish", status: "Done" }] });
      if (path.endsWith("/api/jira/issues/QT1S-31")) return Response.json({ ok: true });
      return Response.json({});
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare action" }));
    expect(await screen.findByText("Change status:").textContent).toContain("Fix queue");
    fireEvent.click(screen.getByRole("button", { name: "Confirm action" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toBe("Action completed."));
  });

  it("reports a prepare failure without offering a confirm button", async () => {
    setup(async () => Response.json({ error: "Model unavailable." }, { status: 502 }));
    fireEvent.click(screen.getByRole("button", { name: "Prepare action" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Model unavailable.");
    expect(screen.queryByRole("button", { name: "Confirm action" })).toBeNull();
  });

  it("keeps Jira confirmation disabled when the current issue transition lookup fails", async () => {
    setup(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/api/assistant/action/prepare")) {
        const body = JSON.parse(String(init?.body ?? "{}"));
        return body.target
          ? Response.json({ ready: true, source: "jira", itemId: "QT1S-31", todayId: "jira:QT1S-31@0", title: "Fix queue", action: "status", value: "Done" })
          : Response.json({ ready: true, source: "jira", itemId: "QT1S-31", todayId: "jira:QT1S-31@0", title: "Fix queue", action: "status" });
      }
      return Response.json({ error: "Jira unavailable." }, { status: 502 });
    });
    fireEvent.click(screen.getByRole("button", { name: "Prepare action" }));
    const confirm = await screen.findByRole("button", { name: "Confirm action" });
    await waitFor(() => expect(confirm.hasAttribute("disabled")).toBe(true));
  });
});
