import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// The palette is a security surface, not decoration: `--color-faint` carries
// the approval card's guardrail line (which surface and which source is asking
// to write), the resolved-outcome line (whether a standing trust grant was
// made), two of the three sidebar tabs and every non-terminal breadcrumb
// label. All of it renders at 10–12.5px, so NONE of it qualifies as WCAG large
// text and all of it owes the full 4.5:1. Read the tokens out of the stylesheet
// rather than restating them, so a token edit is what this test sees.
// Vitest runs with its config directory (client/) as the working directory;
// import.meta.url is not a file: URL under the Vite transform.
const css = readFileSync(resolve(process.cwd(), "src/app.css"), "utf8");

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(css);
  if (!m) throw new Error(`--color-${name} is not a 6-digit hex token in app.css`);
  return m[1];
}

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5]
    .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((c) => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// WCAG 2.1 SC 1.4.3 contrast ratio.
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

// Every background a text token is drawn on: the app body, the sidebar/agent
// panel, and the raised chips, rows and bubbles.
const BACKGROUNDS = ["bg", "panel", "raised"];
// Every token used as a text colour. Border-only tokens (line, line-strong) are
// not here — SC 1.4.3 does not apply to them.
const TEXT = ["ink", "ink-soft", "muted", "faint", "accent", "ok", "warn", "danger"];

describe("theme contrast", () => {
  it.each(TEXT)("--color-%s meets AA on every surface it is drawn on", (name) => {
    for (const surface of BACKGROUNDS) {
      const ratio = contrast(token(name), token(surface));
      expect(
        ratio,
        `--color-${name} (${token(name)}) on --color-${surface} (${token(surface)}) is ${ratio.toFixed(2)}:1`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });

  // Pinned separately because this is the one that regressed: faint on the
  // raised surface is the tightest pairing in the palette, so a token edit that
  // "looks fine" on the body background can still fail here.
  it("keeps faint legible on the raised surface, not just the body", () => {
    expect(contrast(token("faint"), token("raised"))).toBeGreaterThanOrEqual(4.5);
  });
});
