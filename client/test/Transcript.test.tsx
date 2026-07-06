import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Transcript } from "../src/components/Transcript";
import type { TranscriptMessage } from "../src/lib/agentEvents";

function setGeometry(el: HTMLElement, { scrollHeight, clientHeight, scrollTop }: { scrollHeight: number; clientHeight: number; scrollTop: number }) {
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, configurable: true, writable: true });
}

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

  it("mono-styles only the leading slash-command token of a user message", () => {
    render(<Transcript messages={[{ kind: "user", text: "/compact then summarize" }]} busy={false} />);
    const cmd = screen.getByText("/compact");
    expect(cmd.className).toMatch(/font-mono/);
    const bubble = cmd.closest("[data-kind='user']")!;
    expect(bubble.textContent).toBe("/compact then summarize");
  });

  it("auto-scrolls to bottom on a new message while stuck to bottom", () => {
    const one: TranscriptMessage[] = [{ kind: "text", text: "first" }];
    const { rerender, getByTestId } = render(<Transcript messages={one} busy={false} />);
    const container = getByTestId("transcript");
    setGeometry(container, { scrollHeight: 500, clientHeight: 300, scrollTop: 0 });

    const two: TranscriptMessage[] = [...one, { kind: "text", text: "second" }];
    rerender(<Transcript messages={two} busy={false} />);

    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  it("shows a jump-to-latest pill and does NOT auto-scroll after the user scrolls up", () => {
    const one: TranscriptMessage[] = [{ kind: "text", text: "first" }];
    const { rerender, getByTestId, getByTestId: query } = render(<Transcript messages={one} busy={false} />);
    const container = getByTestId("transcript");

    // Simulate the user scrolling far away from the bottom via a wheel event.
    setGeometry(container, { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 });
    fireEvent.wheel(container);

    const two: TranscriptMessage[] = [...one, { kind: "text", text: "second" }];
    rerender(<Transcript messages={two} busy={false} />);

    expect(container.scrollTop).toBe(0);
    expect(query("jump-latest")).toBeTruthy();
  });

  it("clicking jump-to-latest scrolls to bottom and hides the pill", () => {
    const one: TranscriptMessage[] = [{ kind: "text", text: "first" }];
    const { rerender, getByTestId, queryByTestId } = render(<Transcript messages={one} busy={false} />);
    const container = getByTestId("transcript");

    setGeometry(container, { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 });
    fireEvent.wheel(container);

    const two: TranscriptMessage[] = [...one, { kind: "text", text: "second" }];
    rerender(<Transcript messages={two} busy={false} />);
    expect(queryByTestId("jump-latest")).toBeTruthy();

    fireEvent.click(getByTestId("jump-latest"));

    expect(container.scrollTop).toBe(container.scrollHeight);
    expect(queryByTestId("jump-latest")).toBeNull();
  });

  it("a programmatic scroll event does not unlatch stick-to-bottom", () => {
    const one: TranscriptMessage[] = [{ kind: "text", text: "first" }];
    const { rerender, getByTestId } = render(<Transcript messages={one} busy={false} />);
    const container = getByTestId("transcript");

    // A raw 'scroll' event fires on reflow/programmatic scroll too — it must
    // NOT be treated as user intent to leave the bottom.
    setGeometry(container, { scrollHeight: 2000, clientHeight: 300, scrollTop: 0 });
    fireEvent.scroll(container);

    const two: TranscriptMessage[] = [...one, { kind: "text", text: "second" }];
    setGeometry(container, { scrollHeight: 2500, clientHeight: 300, scrollTop: 0 });
    rerender(<Transcript messages={two} busy={false} />);

    expect(container.scrollTop).toBe(container.scrollHeight);
  });

  describe("assistant markdown rendering", () => {
    it("renders emphasis instead of literal asterisks", () => {
      render(<Transcript messages={[{ kind: "text", text: "this is **important** and *subtle*" }]} busy={false} />);
      expect(screen.getByText("important").tagName).toBe("STRONG");
      expect(screen.getByText("subtle").tagName).toBe("EM");
      expect(screen.queryByText(/\*\*/)).toBeNull();
    });

    it("renders inline code and fenced code blocks", () => {
      render(
        <Transcript
          messages={[{ kind: "text", text: "run `npm test` first\n\n```\nconst x = 1;\n```" }]}
          busy={false}
        />,
      );
      expect(screen.getByText("npm test").tagName).toBe("CODE");
      const block = screen.getByText(/const x = 1;/);
      expect(block.closest("pre")).not.toBeNull();
    });

    it("renders lists and headings", () => {
      render(
        <Transcript
          messages={[{ kind: "text", text: "## Plan\n\n- first\n- second\n\n1. one\n2. two" }]}
          busy={false}
        />,
      );
      expect(screen.getByRole("heading", { name: "Plan" })).toBeTruthy();
      expect(screen.getByText("first").closest("ul")).not.toBeNull();
      expect(screen.getByText("one").closest("ol")).not.toBeNull();
    });

    it("renders links that open externally and safely", () => {
      render(<Transcript messages={[{ kind: "text", text: "see [the docs](https://example.com)" }]} busy={false} />);
      const link = screen.getByRole("link", { name: "the docs" });
      expect(link.getAttribute("href")).toBe("https://example.com");
      expect(link.getAttribute("target")).toBe("_blank");
      expect(link.getAttribute("rel")).toContain("noopener");
    });

    it("does not execute raw HTML in assistant text", () => {
      render(<Transcript messages={[{ kind: "text", text: '<img src=x onerror="window.pwned=1">hi' }]} busy={false} />);
      expect(document.querySelector("[data-kind='text'] img")).toBeNull();
    });

    it("leaves user messages as literal text", () => {
      render(<Transcript messages={[{ kind: "user", text: "keep **these** stars" }]} busy={false} />);
      const bubble = screen.getByText(/keep .* stars/).closest("[data-kind='user']")!;
      expect(bubble.textContent).toBe("keep **these** stars");
      expect(bubble.querySelector("strong")).toBeNull();
    });
  });
});
