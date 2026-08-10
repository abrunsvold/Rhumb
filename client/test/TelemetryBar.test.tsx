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
    expect(screen.getByText("6")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("5")).toBeTruthy();
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
});
