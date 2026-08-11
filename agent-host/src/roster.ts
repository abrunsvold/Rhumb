// The @-mention roster is derived from RHUMB_ALLOWED_USERS — the same list the
// identity guard authenticates against, so the room can only mention people who
// can actually get in. There is no source of display names, so the handle is the
// local part of the login, and it degrades to the full login when that would be
// ambiguous.
export interface RosterEntry {
  login: string;
  handle: string;
}

const localPart = (login: string): string =>
  login.includes("@") ? login.slice(0, login.indexOf("@")) : login;

export function buildRoster(logins: string[]): RosterEntry[] {
  const cleaned = [...new Set(logins.map((l) => l.trim().toLowerCase()).filter(Boolean))];
  const counts = new Map<string, number>();
  for (const login of cleaned) {
    const local = localPart(login);
    counts.set(local, (counts.get(local) ?? 0) + 1);
  }
  return cleaned.map((login) => {
    const local = localPart(login);
    return { login, handle: (counts.get(local) ?? 0) > 1 ? login : local };
  });
}
