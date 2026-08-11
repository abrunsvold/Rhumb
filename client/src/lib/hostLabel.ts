// Short label for the status chip: "bmwbox" out of
// "bmwbox.tail9c2e.ts.net". IPv4 has no meaningful first label, so it stays
// whole rather than being cut to a single octet.
export function hostLabelOf(baseUrl: string): string {
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return "";
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  return host.split(".")[0] ?? host;
}
