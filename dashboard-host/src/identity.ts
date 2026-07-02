import type { Request, Response, NextFunction, RequestHandler } from "express";

// Primary auth for identity mode. `tailscale serve` injects Tailscale-User-Login
// on every proxied request and strips any caller-supplied Tailscale-* headers,
// so the header cannot be forged from the network. The hosts bind loopback in
// identity mode, so serve is the only network path in; local processes on the
// box are inside the trust boundary (they already have workspace access).
export function createIdentityGuard(allowedUsers: string[]): RequestHandler {
  const allowed = new Set(allowedUsers.map((u) => u.trim().toLowerCase()).filter(Boolean));
  return (req: Request, res: Response, next: NextFunction): void => {
    const login = req.get("tailscale-user-login")?.trim().toLowerCase() ?? "";
    if (login && allowed.has(login)) return void next();
    res.status(403).json({ error: "forbidden" });
  };
}

// Shell-only routes (write approvals, infra approvals). Browsers refuse to let
// page JavaScript set Sec-* request headers, so agent-built surface content can
// never present this header; the client's Rust proxy always sends it. Layered
// on top of the identity guard — this distinguishes the shell from a surface
// running on the same (identity-authenticated) device.
export function requireShellHeader(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (req.get("sec-rhumb-control") === "1") return void next();
    res.status(403).json({ error: "shell only" });
  };
}
