import { describe, it, expect } from "vitest";
import { withAttachments, splitAttachments } from "../src/lib/attachments";

describe("withAttachments", () => {
  it("appends a trailing attachment line", () => {
    expect(withAttachments("look at this", ["/w/uploads/a.png", "/w/uploads/b.txt"])).toBe(
      "look at this\n\n[Attached files: /w/uploads/a.png, /w/uploads/b.txt]",
    );
  });

  it("returns the text unchanged when there are no attachments", () => {
    expect(withAttachments("plain", [])).toBe("plain");
  });
});

describe("splitAttachments", () => {
  it("round-trips what withAttachments builds", () => {
    const paths = ["/w/uploads/a.png", "/w/uploads/b.txt"];
    expect(splitAttachments(withAttachments("look at this", paths))).toEqual({
      text: "look at this",
      attachments: paths,
    });
  });

  it("leaves a prompt with no attachment line alone", () => {
    expect(splitAttachments("just a prompt")).toEqual({ text: "just a prompt", attachments: [] });
  });

  it("ignores an attachment line that is not at the end", () => {
    const s = "a\n\n[Attached files: /w/x.png]\nmore text";
    expect(splitAttachments(s)).toEqual({ text: s, attachments: [] });
  });

  it("preserves a multi-line body", () => {
    const s = withAttachments("one\ntwo", ["/w/x.png"]);
    expect(splitAttachments(s)).toEqual({ text: "one\ntwo", attachments: ["/w/x.png"] });
  });
});
