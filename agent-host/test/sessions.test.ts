import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionService, truncateTitle } from "../src/sessions.js";

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
