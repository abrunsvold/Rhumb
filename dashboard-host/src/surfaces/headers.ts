
// Security headers set on every surface response. connect-src 'self' blocks a
// malicious surface from exfiltrating data or its token off-host; frame-ancestors
// is the Tauri app origins ONLY (not 'self') so one surface cannot frame another
// (both share the dashboard origin) while the app still can.
export function surfaceHeaders(appOrigins: string[]): Record<string, string> {
  const ancestors = appOrigins.length > 0 ? appOrigins.join(" ") : "'none'";
  const csp = [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self' 'unsafe-inline'",
    `frame-ancestors ${ancestors}`,
  ].join("; ");
  return {
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": csp,
  };
}
