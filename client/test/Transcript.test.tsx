import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Transcript } from "../src/components/Transcript";
import type { TranscriptMessage } from "../src/lib/agentEvents";

describe("Transcript", () => {
  it("shows the empty state when there are no messages", () => {
    render(<Transcript messages={[]} busy={false} />);
    expect(screen.getByText(/send a message to start a session/i)).toBeTruthy();
  });

  it("renders each kind distinctly", () => {
    const messages: TranscriptMessage[] = [
      { kind: "user", text: "hi", attachments: ["a.csv"] },
      { kind: "text", text: "hello back" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { path: "x" } },
      { kind: "error", text: "boom" },
      { kind: "result", text: "turn done" },
    ];
    render(<Transcript messages={messages} busy={false} />);
    expect(screen.getByText("hi").closest("[data-kind]")?.getAttribute("data-kind")).toBe("user");
    expect(screen.getByText("a.csv")).toBeTruthy();
    expect(screen.getByText("hello back")).toBeTruthy();
    expect(screen.getByText(/Read/).closest("[data-kind]")?.getAttribute("data-kind")).toBe("tool");
    expect(screen.getByText("boom").closest("[data-kind]")?.getAttribute("data-kind")).toBe("error");
    expect(screen.getByText("turn done")).toBeTruthy();
  });

  it("expands a tool chip to show its input JSON on click", async () => {
    render(
      <Transcript
        messages={[{ kind: "tool", text: "Read", toolName: "Read", toolInput: { path: "/tmp/x" } }]}
        busy={false}
      />,
    );
    expect(screen.queryByText(/"\/tmp\/x"/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Read/ }));
    expect(screen.getByText(/"\/tmp\/x"/)).toBeTruthy();
  });

  it("shows a thinking indicator while busy", () => {
    render(<Transcript messages={[]} busy={true} />);
    expect(screen.getByText(/thinking/i)).toBeTruthy();
  });
});
