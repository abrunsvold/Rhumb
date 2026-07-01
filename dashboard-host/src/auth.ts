import { timingSafeEqual } from "node:crypto";
import type { Request, Response, NextFunction } from "express";

// Guard the approval control plane with the operator's shared secret. Opt-in:
// when `token` is empty the guard is a no-op; when set, guarded requests must
// present `Authorization: Bearer <token>`. Surfaces never hold this token, so it
// keeps any tailnet device from approving their own pending writes.
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
