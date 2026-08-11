import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryBar } from "../src/components/TelemetryBar";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, rels: number): OntologyNode => ({
  type: "service", id, title: id, managed: "system", props: {},
  relationships: Array.from({ length: rels }, (_, i) => ({ edge: "uses", target: `t${i}` })),
});

describe("TelemetryBar", () => {
  it("counts surfaces, nodes, and summed edges", () => {
    render(<TelemetryBar surfaces={6} nodes={[n("a", 2), n("b", 3)]} queued={0} syncedAt={null} />);
    expect(screen.getByText((_, el) => el?.textContent === "SURFACES 6")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "NODES 2")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "EDGES 5")).toBeTruthy();
  });

  it("reports a clear queue", () => {
    render(<TelemetryBar surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.getByText("QUEUE clear")).toBeTruthy();
  });

  it("reports held items with correct pluralization", () => {
    const { rerender } = render(<TelemetryBar surfaces={0} nodes={[]} queued={1} syncedAt={null} />);
    expect(screen.getByText("QUEUE 1 held")).toBeTruthy();
    rerender(<TelemetryBar surfaces={0} nodes={[]} queued={3} syncedAt={null} />);
    expect(screen.getByText("QUEUE 3 held")).toBeTruthy();
  });

  it("omits the sync stamp when the ontology has never synced", () => {
    render(<TelemetryBar surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.queryByText(/synced/)).toBeNull();
  });

  // With no snapshot at all (mount fetch pending or failed) there is nothing
  // to count: "NODES 0" would be an affirmative claim that the map is empty,
  // which the client cannot support — the same principle the refresh-failure
  // path already follows by keeping the last good snapshot.
  it("shows a placeholder, not zero, while there is no ontology snapshot", () => {
    render(<TelemetryBar surfaces={0} nodes={null} queued={0} syncedAt={null} />);
    expect(screen.getByText(/NODES/).textContent).toBe("NODES —");
    expect(screen.getByText(/EDGES/).textContent).toBe("EDGES —");
    expect(screen.queryByText(/NODES 0/)).toBeNull();
  });

  it("still shows a real zero once an empty snapshot HAS synced", () => {
    render(<TelemetryBar surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.getByText(/NODES/).textContent).toBe("NODES 0");
    expect(screen.getByText(/EDGES/).textContent).toBe("EDGES 0");
  });
});
