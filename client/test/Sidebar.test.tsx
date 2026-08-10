import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Sidebar } from "../src/components/Sidebar";

describe("Sidebar", () => {
  it("renders the three tabs and marks the active one", () => {
    render(
      <Sidebar active="sessions" onSelect={vi.fn()}>
        <p>body</p>
      </Sidebar>,
    );
    expect(screen.getByRole("tab", { name: "SESSIONS" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "MAP" }).getAttribute("aria-selected")).toBe("false");
    expect(screen.getByRole("tab", { name: "HOST" }).getAttribute("aria-selected")).toBe("false");
  });

  it("renders its children as the panel body", () => {
    render(
      <Sidebar active="map" onSelect={vi.fn()}>
        <p>body</p>
      </Sidebar>,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("reports the tab that was clicked", async () => {
    const onSelect = vi.fn();
    render(
      <Sidebar active="sessions" onSelect={onSelect}>
        <p>body</p>
      </Sidebar>,
    );
    await userEvent.click(screen.getByRole("tab", { name: "HOST" }));
    expect(onSelect).toHaveBeenCalledWith("host");
  });
});
