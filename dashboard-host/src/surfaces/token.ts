import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const TOKEN_FILE = ".surface-token";

export function getOrCreateSurfaceToken(surfaceDir: string): string {
  const path = join(surfaceDir, TOKEN_FILE);
  if (existsSync(path)) {
    const t = readFileSync(path, "utf8").trim();
    if (t.length > 0) return t;
  }
  const token = randomBytes(24).toString("base64url");
  writeFileSync(path, token, { mode: 0o600 });
  return token;
}

export function resolveSurfaceToken(surfacesRoot: string, token: string): string | null {
  if (!token) return null;
  if (!existsSync(surfacesRoot)) return null;
  for (const d of readdirSync(surfacesRoot, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const path = join(surfacesRoot, d.name, TOKEN_FILE);
    if (!existsSync(path)) continue;
    // Plain compare: the token is high-entropy and this host is tailnet-only.
    if (readFileSync(path, "utf8").trim() === token) return d.name;
  }
  return null;
}
