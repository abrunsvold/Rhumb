import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Canvas } from "../src/components/Canvas";

const ctor = vi.fn();
let handlers: Record<string, (event: unknown) => void> = {};

vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    once = vi.fn((evt: string, cb: (event: unknown) => void) => {
      handlers[evt] = cb;
    });
    constructor(label: string, opts: { url: string }) {
      ctor(label, opts);
    }
  },
}));

describe("Canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers = {};
  });

  it("renders tabs from the registry stream and the active surface in an iframe", async () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        tabs={[{ id: "demo", title: "Demo", url: "/surfaces/demo/" }]}
        activeId="demo"
        onSelect={() => {}}
      />,
    );
    expect(await screen.findByRole("tab", { name: "Demo" })).toBeTruthy();
    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("http://d:8788/surfaces/demo/");
    // The surface iframe runs with `allow-scripts allow-same-origin`. This is
    // safe NOT because of the sandbox flags alone, but because: the app shell is a
    // different origin (tauri://) so a surface cannot script it; the dashboard
    // isolates data access per-surface via capability tokens; and the surface's
    // own CSP (connect-src 'self') blocks off-host exfiltration.
    expect(iframe?.getAttribute("sandbox")).toContain("allow-scripts");
  });

  it("detaches the active surface into a WebviewWindow", async () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        tabs={[{ id: "demo", title: "Demo", url: "/surfaces/demo/" }]}
        activeId="demo"
        onSelect={() => {}}
      />,
    );
    await screen.findByRole("tab", { name: "Demo" });
    await userEvent.click(screen.getByRole("button", { name: /detach/i }));
    expect(ctor).toHaveBeenCalledWith("surface:demo", expect.objectContaining({ url: "http://d:8788/surfaces/demo/" }));
  });

  it("shows an empty state when the registry has no surfaces", async () => {
    render(<Canvas dashboardBase="http://d:8788" tabs={[]} activeId={null} onSelect={() => {}} />);
    expect(await screen.findByText(/no surfaces yet/i)).toBeTruthy();
  });

  it("marks the active tab with aria-selected", async () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        tabs={[
          { id: "s1", title: "Sales", url: "/surfaces/s1/" },
          { id: "s2", title: "Ops", url: "/surfaces/s2/" },
        ]}
        activeId="s1"
        onSelect={() => {}}
      />,
    );
    const sales = await screen.findByRole("tab", { name: "Sales" });
    expect(sales.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Ops" }).getAttribute("aria-selected")).toBe("false");
  });

  it("surfaces a detach failure inline", async () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        tabs={[{ id: "demo", title: "Demo", url: "/surfaces/demo/" }]}
        activeId="demo"
        onSelect={() => {}}
      />,
    );
    await screen.findByRole("tab", { name: "Demo" });
    await userEvent.click(screen.getByRole("button", { name: /detach/i }));
    expect(handlers["tauri://error"]).toBeTruthy();

    act(() => handlers["tauri://error"](new Event("tauri://error")));
    expect(await screen.findByText(/detach failed/i)).toBeTruthy();
  });

  it("does not show a detach failure when the window is created successfully", async () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        tabs={[{ id: "demo", title: "Demo", url: "/surfaces/demo/" }]}
        activeId="demo"
        onSelect={() => {}}
      />,
    );
    await screen.findByRole("tab", { name: "Demo" });
    await userEvent.click(screen.getByRole("button", { name: /detach/i }));
    expect(handlers["tauri://created"]).toBeTruthy();

    act(() => handlers["tauri://created"](new Event("tauri://created")));
    expect(screen.queryByText(/detach failed/i)).toBeNull();
  });
});
