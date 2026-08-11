import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Canvas } from "../src/components/Canvas";

describe("Canvas", () => {
  it("renders the active surface in an iframe with dashboardBase + url concatenated", () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        active={{ id: "demo", title: "Demo", url: "/surfaces/demo/" }}
      />,
    );
    const iframe = document.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toBe("http://d:8788/surfaces/demo/");
  });

  it("sandboxes the iframe to allow-scripts allow-same-origin exactly", () => {
    render(
      <Canvas
        dashboardBase="http://d:8788"
        active={{ id: "demo", title: "Demo", url: "/surfaces/demo/" }}
      />,
    );
    const iframe = document.querySelector("iframe");
    // The surface iframe runs with `allow-scripts allow-same-origin`. This is
    // safe NOT because of the sandbox flags alone, but because: the app shell is a
    // different origin (tauri://) so a surface cannot script it; the dashboard
    // isolates data access per-surface via capability tokens; and the surface's
    // own CSP (connect-src 'self') blocks off-host exfiltration.
    expect(iframe?.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin");
  });

  it("shows an empty state when there is no active surface", async () => {
    render(<Canvas dashboardBase="http://d:8788" active={null} />);
    expect(await screen.findByText(/no surfaces yet/i)).toBeTruthy();
  });
});
