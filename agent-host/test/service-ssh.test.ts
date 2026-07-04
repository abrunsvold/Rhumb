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

  it("redacts a secret on a single unbroken line longer than the 400-char cap", () => {
    const secret = "FAKEKEY051Hq8x9AbCdEfGhIjKlMnOpQrStUvWxYz0123456789ABCDEF";
    const e = Object.assign(new Error("x"), { code: 1, stderr: `Environment=DATABASE_URL=${"z".repeat(420)} ${secret}` });
    const out = redactSshError("command", e);
    expect(out.message).not.toContain(secret);
    expect(out.message.length).toBeLessThan(450);
  });

  it("redacts a secret even on a single unbroken line longer than the 400-char cap", () => {
    const secret = "FAKEKEY0ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    const longLine = "Environment=DATABASE_URL=" + "z".repeat(500) + secret;
    const e = Object.assign(new Error("boom"), { code: 1, stderr: longLine });
    const out = redactSshError("command", e);
    expect(out.message).not.toContain(secret);
    expect(out.message).not.toContain("FAKEKEY0");
  });
});
