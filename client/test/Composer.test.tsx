import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, act } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Composer } from "../src/components/Composer";

function setup(over?: Partial<{ slashCommands: string[]; onSend: (t: string, f: { name: string; contentBase64: string }[]) => Promise<boolean> }>) {
  const onSend = over?.onSend ?? vi.fn().mockResolvedValue(true);
  render(<Composer slashCommands={over?.slashCommands ?? []} onSend={onSend} />);
  return { onSend };
}

describe("Composer", () => {
  it("Enter sends and clears; Shift+Enter inserts a newline", async () => {
    const { onSend } = setup();
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "line1{Shift>}{Enter}{/Shift}line2");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.type(box, "{Enter}");
    expect(onSend).toHaveBeenCalledWith("line1\nline2", []);
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe(""));
  });

  it("does not send an empty draft", async () => {
    const { onSend } = setup();
    await userEvent.type(screen.getByRole("textbox"), "{Enter}");
    await userEvent.click(screen.getByRole("button", { name: /send/i }));
    expect(onSend).not.toHaveBeenCalled();
  });

  it("keeps the draft when onSend reports failure", async () => {
    const { } = setup({ onSend: vi.fn().mockResolvedValue(false) });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "keep me{Enter}");
    await waitFor(() => expect((box as HTMLTextAreaElement).value).toBe("keep me"));
  });

  it("shows prefix-matching slash commands and inserts the selection", async () => {
    setup({ slashCommands: ["/compact", "/review", "/cost"] });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "/co");
    const options = screen.getAllByRole("option");
    expect(options.map((o) => o.textContent)).toEqual(["/compact", "/cost"]);
    await userEvent.click(options[0]);
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("marks the first slash match — the one Enter/Tab picks — as selected", async () => {
    setup({ slashCommands: ["/compact", "/review", "/cost"] });
    await userEvent.type(screen.getByRole("textbox"), "/co");
    const options = screen.getAllByRole("option");
    expect(options[0].getAttribute("aria-selected")).toBe("true");
    expect(options[1].getAttribute("aria-selected")).toBe("false");
  });

  it("shows no popup when the command list is empty", async () => {
    setup({ slashCommands: [] });
    await userEvent.type(screen.getByRole("textbox"), "/co");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("stages attached files as removable chips and passes them to onSend", async () => {
    const { onSend } = setup();
    const file = new File(["a,b"], "data.csv", { type: "text/csv" });
    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    expect(await screen.findByText(/data\.csv/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /remove data\.csv/i }));
    expect(screen.queryByText(/data\.csv/)).toBeNull();

    await userEvent.upload(screen.getByLabelText(/attach files/i), file);
    await screen.findByText(/data\.csv/);
    await userEvent.type(screen.getByRole("textbox"), "look{Enter}");
    await waitFor(() =>
      expect(onSend).toHaveBeenCalledWith("look", [
        { name: "data.csv", contentBase64: btoa("a,b") },
      ]),
    );
  });

  it("Enter accepts the top autocomplete match instead of sending", async () => {
    const { onSend } = setup({ slashCommands: ["/compact", "/cost"] });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "/co{Enter}");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("Tab accepts the top autocomplete match", async () => {
    const { onSend } = setup({ slashCommands: ["/compact", "/cost"] });
    const box = screen.getByRole("textbox");
    await userEvent.type(box, "/co{Tab}");
    expect(onSend).not.toHaveBeenCalled();
    expect((box as HTMLTextAreaElement).value).toBe("/compact ");
  });

  it("shows Sending… while onSend is in flight", async () => {
    let release!: (v: boolean) => void;
    const onSend = vi.fn(() => new Promise<boolean>((r) => (release = r)));
    render(<Composer slashCommands={[]} onSend={onSend} />);
    await userEvent.type(screen.getByRole("textbox"), "hi{Enter}");
    expect(screen.getByRole("button", { name: /sending…/i })).toBeTruthy();
    await act(async () => release(true));
    expect(screen.getByRole("button", { name: /^send$/i })).toBeTruthy();
  });

  it("rejects files over 20MB at staging with an inline notice", async () => {
    setup();
    const big = new File(["x"], "big.bin");
    Object.defineProperty(big, "size", { value: 20 * 1024 * 1024 + 1 });
    await userEvent.upload(screen.getByLabelText(/attach files/i), big);
    expect(await screen.findByText(/big\.bin is over the 20 MB limit/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /remove big\.bin/i })).toBeNull();
  });

  it("skips an unreadable file with a notice and stages the rest", async () => {
    setup();
    const bad = new File(["x"], "bad.txt");
    const good = new File(["y"], "good.txt");
    const orig = FileReader.prototype.readAsDataURL;
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementationOnce(function (this: FileReader) {
      setTimeout(() => this.onerror?.(new ProgressEvent("error") as any));
    });
    await userEvent.upload(screen.getByLabelText(/attach files/i), [bad, good]);
    expect(await screen.findByText(/bad\.txt could not be read/i)).toBeTruthy();
    expect(await screen.findByText(/good\.txt/)).toBeTruthy();
    FileReader.prototype.readAsDataURL = orig;
  });
});
