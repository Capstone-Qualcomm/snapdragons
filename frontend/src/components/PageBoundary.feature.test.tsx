import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PageBoundary } from "./PageBoundary";

let broken = true;
function Flaky() {
  if (broken) throw new Error("Bad time value");
  return <p>Page works</p>;
}

afterEach(() => {
  cleanup();
  broken = true;
  vi.restoreAllMocks();
});

describe("PageBoundary", () => {
  it("shows the error in place of a crashed page, and Retry draws it again", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<><nav>Sidebar</nav><PageBoundary><Flaky /></PageBoundary></>);
    expect(screen.getByText("Sidebar")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "This page hit an error" })).toBeTruthy();
    expect(screen.getByRole("alert").textContent).toContain("Bad time value");

    broken = false;
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(screen.getByText("Page works")).toBeTruthy();
  });

  it("shows nothing for a crashed page that is hidden", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(<PageBoundary active={false}><Flaky /></PageBoundary>);
    expect(container.innerHTML).toBe("");
  });
});
