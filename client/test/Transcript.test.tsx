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

  it("mono-styles only the leading slash-command token of a user message", () => {
    render(<Transcript messages={[{ kind: "user", text: "/compact then summarize" }]} busy={false} />);
    const cmd = screen.getByText("/compact");
    expect(cmd.className).toMatch(/font-mono/);
    const bubble = cmd.closest("[data-kind='user']")!;
    expect(bubble.textContent).toBe("/compact then summarize");
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
