// The prompt handed to the agent carries uploaded file paths on a trailing
// line so the model can read them. The sender builds that line and every other
// client in the room parses it back off the broadcast, so both directions live
// here — otherwise one person's attachments render as chips and everyone
// else's render as a raw path line in the same transcript.
const SUFFIX_RE = /\n\n\[Attached files: ([^\]\n]+)\]$/;

export function withAttachments(text: string, paths: string[]): string {
  if (paths.length === 0) return text;
  return `${text}\n\n[Attached files: ${paths.join(", ")}]`;
}

export function splitAttachments(prompt: string): { text: string; attachments: string[] } {
  const m = SUFFIX_RE.exec(prompt);
  if (!m) return { text: prompt, attachments: [] };
  return {
    text: prompt.slice(0, m.index),
    attachments: m[1].split(", ").filter(Boolean),
  };
}
