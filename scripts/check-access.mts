#!/usr/bin/env node
// Checks a running gateway from this machine the way a local process that is not the user would
// reach it: no session cookie, and a made-up Tailscale login. Everything that acts as the user must
// be refused on both ports, while health and the Bots' tool server still answer. Exits 1 if anything
// that should be refused answers.
//   node scripts/check-access.mts [--port 3780] [--tailnet-port 3781] [--user you@example.com] [--url https://machine.tailnet.ts.net]
// --user defaults to the first allowed Tailscale user in access.json; --url is the tailnet address, checked without a cookie.
import { readFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { homedir } from "node:os";
import path from "node:path";
import { tokenForBot } from "../server/bot-token.mts";

const arg = (name: string) => { const index = process.argv.indexOf(`--${name}`); return index > 0 ? process.argv[index + 1] : undefined; };
const home = process.env.THREEBOT_HOME ?? path.join(homedir(), ".threebot");
const read = (file: string) => { try { return readFileSync(path.join(home, file), "utf8"); } catch { return null; } };
const access = JSON.parse(read("bots/.botapp/access.json") ?? "{}");
const port = Number(arg("port") ?? 3780);
const tailnetPort = Number(arg("tailnet-port") ?? access.tailscale?.port ?? 3781);
const user = arg("user") ?? access.tailscale?.users?.[0] ?? "someone@example.com";
const url = arg("url");

// What acting as the user looks like: Bots, the Vault, T3 through the gateway, approving a handoff.
const USER_ROUTES: [string, string][] = [
  ["GET", "/api/bots"], ["GET", "/api/vault"], ["GET", "/api/vault/export.csv"], ["GET", "/api/settings"], ["GET", "/t3/api/projects"],
  ["POST", "/api/bots/x/handoffs/00000000-0000-4000-8000-000000000000/approve"],
];
let failed = 0;
const report = (ok: boolean, line: string) => { if (!ok) failed++; console.log(`${ok ? "ok  " : "FAIL"} ${line}`); };
const status = async (base: string, method: string, route: string, headers: Record<string, string>) => {
  try {
    return (await fetch(base + route, { method, headers: { "content-type": "application/json", ...headers }, body: method === "GET" ? undefined : "{}", redirect: "manual", signal: AbortSignal.timeout(10_000) })).status;
  } catch { return 0; }
};
// The upgrade is asked for by hand: 101 means the gateway opened the socket to T3.
const socket = (base: string, headers: Record<string, string>) => new Promise<number | string>((resolve) => {
  const target = new URL(base + "/t3/ws");
  const request = (target.protocol === "https:" ? https : http).request(target, { headers: { connection: "Upgrade", upgrade: "websocket", "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", ...headers }, timeout: 10_000 });
  request.on("upgrade", (_response, upgraded) => { upgraded.destroy(); resolve(101); });
  request.on("response", (response) => { response.resume(); resolve(response.statusCode ?? 0); });
  request.on("timeout", () => { request.destroy(); resolve("no answer"); });
  request.on("error", () => resolve("no answer"));
  request.end();
});
// A port reduced to the landing page answers 404 to the whole app, the session question included.
// Anywhere else only 401 or 403 is a refusal: a 404 there can be an open route that found nothing.
const refusals = async (base: string) => (await status(base, "GET", "/api/session", {})) === 404 ? [404] : [401, 403];

for (const [name, base, headers] of [
  [`port ${port}, no cookie`, `http://127.0.0.1:${port}`, {}],
  [`port ${port}, made-up Tailscale login`, `http://127.0.0.1:${port}`, { "tailscale-user-login": user }],
  [`tailnet port ${tailnetPort}, no cookie`, `http://127.0.0.1:${tailnetPort}`, {}],
  [`tailnet port ${tailnetPort}, made-up Tailscale login`, `http://127.0.0.1:${tailnetPort}`, { "tailscale-user-login": user }],
  ...(url ? [[`${url}, no cookie`, url.replace(/\/$/, ""), {}] as [string, string, Record<string, string>]] : []),
] as [string, string, Record<string, string>][]) {
  const allowed = await refusals(base);
  const refused = (code: number | string) => typeof code === "number" && allowed.includes(code);
  for (const [method, route] of USER_ROUTES) {
    const code = await status(base, method, route, headers);
    report(refused(code), `${name}: ${method} ${route} -> ${code || "no answer"}`);
  }
  const upgrade = await socket(base, headers);
  report(refused(upgrade), `${name}: WebSocket /t3/ws -> ${upgrade}`);
}

// What local callers legitimately need.
report((await status(`http://127.0.0.1:${port}`, "GET", "/api/health", {})) === 200, `port ${port}: GET /api/health answers`);
const secret = read(".bot-mcp-token")?.trim();
const slug = arg("bot") ?? "canonillo";
if (secret) {
  const response = await fetch(`http://127.0.0.1:${port}/mcp/bot`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tokenForBot(secret, slug)}` }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }) }).catch(() => null);
  report(response?.status === 200, `port ${port}: the Bots' tool server answers ${slug}'s bearer -> ${response?.status ?? "no answer"}`);
  const none = await status(`http://127.0.0.1:${port}`, "POST", "/mcp/bot", {});
  report(none === 401, `port ${port}: the Bots' tool server refuses a caller with no bearer -> ${none}`);
} else console.log("skip the Bots' tool server: no .bot-mcp-token in " + home);

console.log(failed ? `\n${failed} check(s) failed: a local process can act as the user.` : "\nA local process without the session is refused everywhere it should be.");
process.exit(failed ? 1 : 0);
