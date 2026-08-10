import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { RoomStrip } from "../src/components/RoomStrip";

const roster = [
  { login: "op@example.com", handle: "op" },
  { login: "zoe@example.com", handle: "zoe" },
];

describe("RoomStrip", () => {
  it("renders nothing when you are alone and the queue is empty", () => {
    const { container } = render(
      <RoomStrip presence={["op@example.com"]} queueDepth={0} roster={roster} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing when nobody is reported present", () => {
    const { container } = render(<RoomStrip presence={[]} queueDepth={0} roster={roster} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("names everyone present by handle when someone else is here", () => {
    render(
      <RoomStrip
        presence={["op@example.com", "zoe@example.com"]}
        queueDepth={0}
        roster={roster}
      />,
    );
    expect(screen.getByTestId("room-strip")).toHaveTextContent("op");
    expect(screen.getByTestId("room-strip")).toHaveTextContent("zoe");
  });

  it("falls back to the full login for someone not in the roster", () => {
    render(
      <RoomStrip presence={["op@example.com", "gone@example.com"]} queueDepth={0} roster={roster} />,
    );
    expect(screen.getByTestId("room-strip")).toHaveTextContent("gone@example.com");
  });

  it("shows the queue depth even when you are alone", () => {
    render(<RoomStrip presence={["op@example.com"]} queueDepth={2} roster={roster} />);
    expect(screen.getByTestId("room-strip")).toHaveTextContent("2 waiting");
  });
});
