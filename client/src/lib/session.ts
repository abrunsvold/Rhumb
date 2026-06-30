export interface TrackedSession {
  id: string;
  title: string;
  createdAt: string;
}

export function addSession(
  list: TrackedSession[],
  session: TrackedSession,
): TrackedSession[] {
  if (list.some((x) => x.id === session.id)) return list;
  return [session, ...list];
}
