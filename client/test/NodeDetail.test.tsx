import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { NodeDetail } from "../src/components/NodeDetail";
import type { OntologyNode } from "../src/lib/types";

const node: OntologyNode = {
  type: "service",
  id: "service-api",
  title: "printer-api",
  managed: "system",
  props: { container: "LXC 118", p95: "38 ms" },
  relationships: [{ edge: "serves", target: "printer-farm" }],
};

describe("NodeDetail", () => {
  it("shows the type, title, props, and edges", () => {
    render(<NodeDetail node={node} />);
    expect(screen.getByText("service")).toBeTruthy();
    expect(screen.getByText("printer-api")).toBeTruthy();
    expect(screen.getByText("container")).toBeTruthy();
    expect(screen.getByText("LXC 118")).toBeTruthy();
    expect(screen.getByText("serves")).toBeTruthy();
    expect(screen.getByText("printer-farm")).toBeTruthy();
  });

  it("explains a node with no edges rather than showing an empty section", () => {
    render(<NodeDetail node={{ ...node, relationships: [] }} />);
    expect(screen.getByText(/nothing depends on it/i)).toBeTruthy();
  });

  it("renders without props", () => {
    render(<NodeDetail node={{ ...node, props: {} }} />);
    expect(screen.getByText("printer-api")).toBeTruthy();
  });
});
