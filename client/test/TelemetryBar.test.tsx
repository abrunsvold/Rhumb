import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TelemetryBar } from "../src/components/TelemetryBar";
import type { OntologyNode } from "../src/lib/types";

const n = (id: string, rels: number): OntologyNode => ({
  type: "service", id, title: id, managed: "system", props: {},
  relationships: Array.from({ length: rels }, (_, i) => ({ edge: "uses", target: `t${i}` })),
});

const noRoom = { presence: [], turnDepth: 0, roster: [] };

describe("TelemetryBar", () => {
  it("counts surfaces, nodes, and summed edges", () => {
    render(<TelemetryBar {...noRoom} surfaces={6} nodes={[n("a", 2), n("b", 3)]} queued={0} syncedAt={null} />);
    expect(screen.getByText((_, el) => el?.textContent === "SURFACES 6")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "NODES 2")).toBeTruthy();
    expect(screen.getByText((_, el) => el?.textContent === "EDGES 5")).toBeTruthy();
  });

  it("reports a clear queue", () => {
    render(<TelemetryBar {...noRoom} surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.getByText("QUEUE clear")).toBeTruthy();
  });

  it("reports held items with correct pluralization", () => {
    const { rerender } = render(<TelemetryBar {...noRoom} surfaces={0} nodes={[]} queued={1} syncedAt={null} />);
    expect(screen.getByText("QUEUE 1 held")).toBeTruthy();
    rerender(<TelemetryBar {...noRoom} surfaces={0} nodes={[]} queued={3} syncedAt={null} />);
    expect(screen.getByText("QUEUE 3 held")).toBeTruthy();
  });

  it("omits the sync stamp when the ontology has never synced", () => {
    render(<TelemetryBar {...noRoom} surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.queryByText(/synced/)).toBeNull();
  });

  // With no snapshot at all (mount fetch pending or failed) there is nothing
  // to count: "NODES 0" would be an affirmative claim that the map is empty,
  // which the client cannot support — the same principle the refresh-failure
  // path already follows by keeping the last good snapshot.
  it("shows a placeholder, not zero, while there is no ontology snapshot", () => {
    render(<TelemetryBar {...noRoom} surfaces={0} nodes={null} queued={0} syncedAt={null} />);
    expect(screen.getByText(/NODES/).textContent).toBe("NODES —");
    expect(screen.getByText(/EDGES/).textContent).toBe("EDGES —");
    expect(screen.queryByText(/NODES 0/)).toBeNull();
  });

  it("still shows a real zero once an empty snapshot HAS synced", () => {
    render(<TelemetryBar {...noRoom} surfaces={0} nodes={[]} queued={0} syncedAt={null} />);
    expect(screen.getByText(/NODES/).textContent).toBe("NODES 0");
    expect(screen.getByText(/EDGES/).textContent).toBe("EDGES 0");
  });
});

// Ported from the RoomStrip the reskin superseded: the room segments keep its
// contract — invisible when you are alone and the turn queue is idle, so the
// single-user bar looks exactly as it did before rooms existed.
describe("TelemetryBar room segments", () => {
  const roster = [
    { login: "op@example.com", handle: "op" },
    { login: "zoe@example.com", handle: "zoe" },
  ];
  const base = { surfaces: 0, nodes: [], queued: 0, syncedAt: null };

  it("renders neither segment when you are alone and the queue is empty", () => {
    render(<TelemetryBar {...base} presence={["op@example.com"]} turnDepth={0} roster={roster} />);
    expect(screen.queryByTestId("room-presence")).toBeNull();
    expect(screen.queryByTestId("room-waiting")).toBeNull();
  });

  it("renders neither segment when nobody is reported present", () => {
    render(<TelemetryBar {...base} presence={[]} turnDepth={0} roster={roster} />);
    expect(screen.queryByTestId("room-presence")).toBeNull();
  });

  it("names everyone present by handle when someone else is here", () => {
    render(
      <TelemetryBar {...base} presence={["op@example.com", "zoe@example.com"]} turnDepth={0} roster={roster} />,
    );
    expect(screen.getByTestId("room-presence")).toHaveTextContent("op");
    expect(screen.getByTestId("room-presence")).toHaveTextContent("zoe");
  });

  it("falls back to the full login for someone not in the roster", () => {
    render(
      <TelemetryBar {...base} presence={["op@example.com", "gone@example.com"]} turnDepth={0} roster={roster} />,
    );
    expect(screen.getByTestId("room-presence")).toHaveTextContent("gone@example.com");
  });

  it("hides the waiting segment when alone with only the running turn counted (depth 1)", () => {
    render(<TelemetryBar {...base} presence={["op@example.com"]} turnDepth={1} roster={roster} />);
    expect(screen.queryByTestId("room-waiting")).toBeNull();
  });

  it("shows the turn depth minus the running turn", () => {
    render(<TelemetryBar {...base} presence={["op@example.com"]} turnDepth={3} roster={roster} />);
    expect(screen.getByTestId("room-waiting")).toHaveTextContent("TURNS 2 waiting");
  });
});
