import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync, mkdirSync as mkdirSyncFs } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createSessionService, truncateTitle, encodeProjectDir } from "../src/sessions.js";

function service(nowRef = { t: "2026-07-02T00:00:00Z" }) {
  const dir = mkdtempSync(join(tmpdir(), "rhumb-sess-"));
  const svc = createSessionService({
    indexPath: join(dir, "sessions.json"),
    projectsDir: join(dir, "projects"),
    workspace: join(dir, "ws"),
    now: () => nowRef.t,
  });
  return { svc, dir, nowRef };
}

describe("truncateTitle", () => {
  it("passes short prompts through", () => {
    expect(truncateTitle("fix the header")).toBe("fix the header");
  });
  it("truncates at a word boundary under 60 chars and appends an ellipsis", () => {
    const long = "analyze the printer telemetry table and produce a weekly summary of anomalies";
    const t = truncateTitle(long);
    expect(t.length).toBeLessThanOrEqual(61); // 60 + ellipsis char
    expect(t.endsWith("…")).toBe(true);
    expect(t).not.toMatch(/\s…$/); // no dangling space before ellipsis
  });
  it("collapses newlines to spaces", () => {
    expect(truncateTitle("line one\nline two")).toBe("line one line two");
  });
});

describe("session index", () => {
  it("creates a session on first upsert with title=preview=truncated prompt", () => {
    const { svc } = service();
    svc.upsertFromTurn("s1", "hello there");
    const [s] = svc.list();
    expect(s).toEqual({
      id: "s1",
      title: "hello there",
      createdAt: "2026-07-02T00:00:00Z",
      lastActiveAt: "2026-07-02T00:00:00Z",
      preview: "hello there",
      archived: false,
    });
  });

  it("bumps lastActiveAt (not title/createdAt) on later turns and sorts newest first", () => {
    const { svc, nowRef } = service();
    svc.upsertFromTurn("s1", "first session");
    nowRef.t = "2026-07-02T01:00:00Z";
    svc.upsertFromTurn("s2", "second session");
    nowRef.t = "2026-07-02T02:00:00Z";
    svc.upsertFromTurn("s1", "a much later prompt");
    const list = svc.list();
    expect(list.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(list[0].title).toBe("first session");
    expect(list[0].createdAt).toBe("2026-07-02T00:00:00Z");
    expect(list[0].lastActiveAt).toBe("2026-07-02T02:00:00Z");
  });

  it("persists atomically and reloads from disk", () => {
    const { svc, dir } = service();
    svc.upsertFromTurn("s1", "persist me");
    expect(existsSync(join(dir, "sessions.json"))).toBe(true);
    expect(existsSync(join(dir, "sessions.json.tmp"))).toBe(false);
    const raw = JSON.parse(readFileSync(join(dir, "sessions.json"), "utf8"));
    expect(raw[0].id).toBe("s1");
    // a fresh service over the same file sees the data
    const svc2 = createSessionService({
      indexPath: join(dir, "sessions.json"),
      projectsDir: join(dir, "projects"),
      workspace: join(dir, "ws"),
      now: () => "2026-07-02T09:00:00Z",
    });
    expect(svc2.list()[0].id).toBe("s1");
  });

  it("rename validates and archive hides from the default list", () => {
    const { svc } = service();
    svc.upsertFromTurn("s1", "one");
    svc.upsertFromTurn("s2", "two");
    expect(svc.rename("s1", "Better name")).toBe(true);
    expect(svc.rename("missing", "x")).toBe(false);
    expect(svc.list().find((s) => s.id === "s1")?.title).toBe("Better name");
    expect(svc.archive("s2")).toBe(true);
    expect(svc.list().map((s) => s.id)).toEqual(["s1"]);
    expect(svc.list(true).map((s) => s.id).sort()).toEqual(["s1", "s2"]);
  });

  it("survives a corrupt index file by starting empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "rhumb-sess-"));
    const indexPath = join(dir, "sessions.json");
    writeFileSync(indexPath, "{not json");
    const svc = createSessionService({
      indexPath,
      projectsDir: join(dir, "p"),
      workspace: join(dir, "w"),
      now: () => "2026-07-02T00:00:00Z",
    });
    expect(svc.list()).toEqual([]);
  });
});

describe("transcript reader", () => {
  it("encodes the project dir like the SDK (slashes and dots become dashes)", () => {
    expect(encodeProjectDir("/root/rhumbr-workspace")).toBe("-root-rhumbr-workspace");
    expect(encodeProjectDir("/Users/x/My.App")).toBe("-Users-x-My-App");
  });

  function withTranscript(lines: unknown[]) {
    const { svc, dir } = service();
    const ws = resolve(join(dir, "ws"));
    const sessDir = join(dir, "projects", encodeProjectDir(ws));
    mkdirSyncFs(sessDir, { recursive: true });
    writeFileSync(
      join(sessDir, "abc-123.jsonl"),
      lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
    );
    return svc;
  }

  it("parses user text, assistant text, and tool_use into TranscriptMessages", () => {
    const svc = withTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "text", text: "read the file" }] } },
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [
        { type: "tool_use", id: "t1", name: "Read", input: { file_path: "x.txt" } },
        { type: "text", text: "done" },
      ] } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([
      { kind: "user", text: "read the file" },
      { kind: "tool", text: "Read", toolName: "Read", toolInput: { file_path: "x.txt" } },
      { kind: "text", text: "done" },
    ]);
  });

  it("skips sidechains, unknown types, tool_result blocks, string content on unknown roles, and garbage lines", () => {
    const svc = withTranscript([
      { type: "queue-operation", operation: "enqueue" },
      { type: "user", isSidechain: true, message: { role: "user", content: [{ type: "text", text: "hidden" }] } },
      { type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "..." }] } },
      "{not json",
      { type: "assistant", isSidechain: false, message: { role: "assistant", content: [{ type: "text", text: "visible" }] } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([{ kind: "text", text: "visible" }]);
  });

  it("handles plain-string user content", () => {
    const svc = withTranscript([
      { type: "user", isSidechain: false, message: { role: "user", content: "just a string" } },
    ]);
    expect(svc.readTranscript("abc-123")).toEqual([{ kind: "user", text: "just a string" }]);
  });

  it("returns null for a missing session file", () => {
    const { svc } = service();
    expect(svc.readTranscript("nope")).toBeNull();
  });
});
