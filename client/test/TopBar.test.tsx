import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { TopBar } from "../src/components/TopBar";
import { checkHealthTimed } from "../src/lib/tauri";

vi.mock("../src/lib/tauri", () => ({
  checkHealthTimed: vi.fn().mockResolvedValue({ ok: true, ms: 41 }),
}));

beforeEach(() => {
  vi.mocked(checkHealthTimed).mockClear();
});

describe("TopBar", () => {
  it("shows the wordmark, session title, and turn count", () => {
    render(<TopBar title="Printer farm tracker" turns={3} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    expect(screen.getByText("RHUMB")).toBeTruthy();
    expect(screen.getByText("Printer farm tracker")).toBeTruthy();
    expect(screen.getByText("3 turns")).toBeTruthy();
  });

  it("singularizes a single turn", () => {
    render(<TopBar title="x" turns={1} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    expect(screen.getByText("1 turn")).toBeTruthy();
  });

  it("shows the host label and measured latency once the probe resolves", async () => {
    render(<TopBar title="x" turns={0} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    await waitFor(() => expect(screen.getByText(/bmwbox/)).toBeTruthy());
    expect(screen.getByText(/41ms/)).toBeTruthy();
  });

  it("reports an unreachable host instead of a latency figure", async () => {
    vi.mocked(checkHealthTimed).mockResolvedValueOnce({ ok: false, ms: 3000 });
    render(<TopBar title="x" turns={0} baseUrl="https://bmwbox.tail9c2e.ts.net" />);
    await waitFor(() => expect(screen.getByText(/unreachable/)).toBeTruthy());
    expect(screen.queryByText(/3000ms/)).toBeNull();
  });
});
