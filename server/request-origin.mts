import type { IncomingHttpHeaders } from "node:http";

// A signed-in browser attaches its cookie to requests that other websites start, and browsers
// don't apply the same-origin policy to WebSockets. So being authenticated isn't enough: anything
// that can change state must also have come from this app. Cookies ignore the port, so a page
// served from another port of this machine is as foreign as any other site.
export function allowedOrigins(env = process.env) {
  return new Set(String(env.ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean));
}

export function sameOriginRequest(req: { headers: IncomingHttpHeaders }, { allowed = new Set() }: { allowed?: Set<string> } = {}): boolean {
  const origin = req.headers.origin;
  // Scripts, curl and the Bots' tools send no Origin. They still need a valid credential.
  if (origin === undefined) return req.headers["sec-fetch-site"] !== "cross-site";
  if (allowed.has(origin)) return true;
  let parsed;
  try { parsed = new URL(origin); } catch { return false; }
  return parsed.host === req.headers.host;
}
