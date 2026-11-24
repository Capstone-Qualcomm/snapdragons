import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { NotionPage, Source } from "../Today/sources";
import { DocumentsPage } from "./DocumentsPage";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function source(overrides: Partial<Source<NotionPage>> = {}): Source<NotionPage> {
  return {
    name: "notion",
    title: "Notion",
    status: "error",
    syncing: false,
    items: [],
    error: "Notion authorization expired. Reconnect Notion.",
    loadedAt: null,
    account: "Workspace",
    reload: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    ...overrides,
  };
}

describe("Documents recovery", () => {
  it("keeps previously loaded document cards visible beside a refresh error", () => {
    render(<DocumentsPage notion={source({
      items: [{ id: "page-1", title: "Project notes", updatedAt: "2026-01-01T00:00:00Z", url: "https://notion.so/page-1" }],
      loadedAt: 1,
    })} />);

    expect(screen.getByRole("link", { name: /Project notes/ })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Notion authorization expired");
    expect(screen.getByRole("link", { name: "Reconnect Notion" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "manage connections" })).toBeTruthy();
  });

  it("shows recovery guidance when the first document load fails", () => {
    render(<DocumentsPage notion={source({ error: "Notion denied access. Check the pages shared with this connection." })} />);

    expect(screen.queryByRole("list", { name: "Documents" })).toBeNull();
    expect(screen.getByText(/Check the pages shared with this connection/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Reconnect Notion" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Manage connections" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry" })).toBeTruthy();
  });
});
