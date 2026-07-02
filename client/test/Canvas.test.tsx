import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { RegistrySnapshot } from "../src/lib/types";
import { Canvas } from "../src/components/Canvas";

let capturedOnUpdate: ((s: RegistrySnapshot) => void) | null = null;
const ctor = vi.fn();

vi.mock("../src/lib/tauri", () => ({
  openRegistryStream: vi.fn((_base: string, onUpdate: (s: RegistrySnapshot) => void) => {
    capturedOnUpdate = onUpdate;
    return () => {};
  }),
}));
vi.mock("@tauri-apps/api/webviewWindow", () => ({
  WebviewWindow: class {
    constructor(label: string, opts: { url: string }) {
      ctor(label, opts);
    }
  },
}));

function emitSnapshot(snapshot: RegistrySnapshot) {
  capturedOnUpdate?.(snapshot);
}

describe("Canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedOnUpdate = null;
  });

  it("renders tabs from the registry stream and the active surface in an iframe", async () => {
    render(<Canvas dashboardBase="http://d:8788" />);
    capturedOnUpdate?.({
      surfaces: [{ id: "demo", title: "Demo", url: "/surfaces/demo/", kind: "file", created: "t", updated: "t" }],
    });
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
    render(<Canvas dashboardBase="http://d:8788" />);
    capturedOnUpdate?.({
      surfaces: [{ id: "demo", title: "Demo", url: "/surfaces/demo/", kind: "file", created: "t", updated: "t" }],
    });
    await screen.findByRole("tab", { name: "Demo" });
    await userEvent.click(screen.getByRole("button", { name: /detach/i }));
    expect(ctor).toHaveBeenCalledWith("surface:demo", expect.objectContaining({ url: "http://d:8788/surfaces/demo/" }));
  });

  it("shows an empty state when the registry has no surfaces", async () => {
    render(<Canvas dashboardBase="http://d:8788" />);
    emitSnapshot({ surfaces: [] });
    expect(await screen.findByText(/no surfaces yet/i)).toBeTruthy();
  });

  it("marks the active tab with aria-selected", async () => {
    render(<Canvas dashboardBase="http://d:8788" />);
    emitSnapshot({
      surfaces: [
        { id: "s1", title: "Sales", url: "/surfaces/s1/", kind: "dashboard", created: "", updated: "" },
        { id: "s2", title: "Ops", url: "/surfaces/s2/", kind: "dashboard", created: "", updated: "" },
      ],
    });
    const sales = await screen.findByRole("tab", { name: "Sales" });
    expect(sales.getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "Ops" }).getAttribute("aria-selected")).toBe("false");
  });
});
