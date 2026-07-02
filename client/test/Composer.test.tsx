import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
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
});
