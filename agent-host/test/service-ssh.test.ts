import { describe, it, expect } from "vitest";
import { redactSshError } from "../src/services/ssh.js";

const SECRET = "postgres://printers:s3cretpw@192.168.1.91:5432/printers";

describe("redactSshError", () => {
  it("never includes the original message (which embeds the command line)", () => {
    const e = Object.assign(new Error(`Command failed: ssh ... cat > unit <<EOF\nEnvironment=DATABASE_URL=${SECRET}\nEOF`), { code: 1, stderr: "" });
    const out = redactSshError("command", e);
    expect(out.message).not.toContain("postgres://");
    expect(out.message).not.toContain("s3cretpw");
    expect(out.message).not.toContain("Environment=");
    expect(out.message).toContain("exit 1");
  });

  it("redacts secret-bearing lines from the stderr tail but keeps benign lines", () => {
    const e = Object.assign(new Error("boom"), { code: 127, stderr: `bash: line 3: npm: command not found\nEnvironment=DATABASE_URL=${SECRET}\n` });
    const out = redactSshError("command", e);
    expect(out.message).toContain("npm: command not found");
    expect(out.message).toContain("[redacted line]");
    expect(out.message).not.toContain("s3cretpw");
    expect(out.message).toContain("exit 127");
  });

  it("handles missing code/stderr (spawn errors) and the copy verb", () => {
    const out = redactSshError("copy", new Error("spawn scp ENOENT"));
    expect(out.message).toBe("ssh copy failed (exit ?)");
  });

  it("caps the stderr tail at 400 chars", () => {
    const e = Object.assign(new Error("x"), { code: 1, stderr: "a".repeat(1000) });
    expect(redactSshError("command", e).message.length).toBeLessThan(450);
  });
});
