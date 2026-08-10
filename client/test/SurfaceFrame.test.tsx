import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SurfaceFrame } from "../src/components/SurfaceFrame";

describe("SurfaceFrame", () => {
  it("renders each lineage label with arrows between but not after", () => {
    render(
      <SurfaceFrame lineage={["pg printers", "printer-api", "printer-farm"]} onDetach={vi.fn()} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("pg printers")).toBeTruthy();
    expect(screen.getByText("printer-farm")).toBeTruthy();
    expect(screen.getAllByText("→")).toHaveLength(2);
  });

  it("renders the body", () => {
    render(
      <SurfaceFrame lineage={[]} onDetach={vi.fn()} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("body")).toBeTruthy();
  });

  it("calls onDetach", async () => {
    const onDetach = vi.fn();
    render(
      <SurfaceFrame lineage={["x"]} onDetach={onDetach} detachError={false}>
        <p>body</p>
      </SurfaceFrame>,
    );
    await userEvent.click(screen.getByRole("button", { name: /DETACH/ }));
    expect(onDetach).toHaveBeenCalled();
  });

  it("surfaces a detach failure", () => {
    render(
      <SurfaceFrame lineage={["x"]} onDetach={vi.fn()} detachError>
        <p>body</p>
      </SurfaceFrame>,
    );
    expect(screen.getByText("Detach failed")).toBeTruthy();
  });
});
