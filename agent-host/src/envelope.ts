// Every turn handed to the backend is prefixed with the sender's login, so
// attribution lands in Claude Code's own JSONL transcript and replays without
// a second store. See docs/superpowers/specs/2026-08-04-multi-user-rooms-design.md.
//
// Live attribution is unforgeable (the login is header-derived, and `tailscale
// serve` strips caller-supplied Tailscale-* headers). REPLAYED attribution is
// best-effort: a user can type a fake first line and mislabel themselves in the
// log. That is accepted for a trusted shared-desk room; the alternative is a
// second store that can disagree with the transcript.
const ENVELOPE_RE = /^\[from: ([^\]\n]+)\]\n([\s\S]*)$/;

export function stampAuthor(author: string, text: string): string {
  return `[from: ${author}]\n${text}`;
}

export function parseEnvelope(text: string): { author: string | null; text: string } {
  const m = ENVELOPE_RE.exec(text);
  if (!m) return { author: null, text };
  return { author: m[1], text: m[2] };
}
