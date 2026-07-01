import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Guard the control plane with a shared operator secret. When `token` is empty
// the guard is a no-op (auth is opt-in), but when set every guarded request must
// present `Authorization: Bearer <token>`. This is what keeps any other device on
// the tailnet from driving the agent or approving gated infrastructure actions.
export function createControlTokenGuard(token: string | undefined) {
  const expected = token?.trim();
  return function requireControlToken(req: Request, res: Response, next: NextFunction): void {
    if (!expected) return void next();
    const header = req.get("authorization") ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
    const a = Buffer.from(presented);
    const b = Buffer.from(expected);
    if (a.length === b.length && timingSafeEqual(a, b)) return void next();
    res.status(401).json({ error: "unauthorized" });
  };
}
