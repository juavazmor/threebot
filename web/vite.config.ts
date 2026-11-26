import type { IncomingMessage } from "node:http";
import { defineConfig, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { pwaPrecache } from "./plugins/pwaPrecache.ts";

const gateway = process.env.BOT_GATEWAY ?? "http://127.0.0.1:3780";
// Optional for local development: a gateway session cookie, so the dev server can talk to it without a browser login.
const devCookie = process.env.BOT_SESSION ? { cookie: `bot_session=${process.env.BOT_SESSION}` } : undefined;

// The gateway only takes changes and sockets from its own pages. This dev server is those pages in
// development, so a request from one of its own pages reaches the gateway as the gateway's own.
// A request another site started keeps its Origin and is refused there as usual.
const ownPagesAreTheGateways: ProxyOptions["configure"] = (proxy) => {
  const rewrite = (proxyReq: { setHeader(name: string, value: string): void }, req: IncomingMessage) => {
    const origin = req.headers.origin;
    if (origin && req.headers.host && origin.replace(/^https?:\/\//, "") === req.headers.host) proxyReq.setHeader("origin", new URL(gateway).origin);
  };
  proxy.on("proxyReq", rewrite);
  proxy.on("proxyReqWs", rewrite);
};

export default defineConfig({
  plugins: [react(), tailwindcss(), pwaPrecache()],
  server: {
    port: 5180,
    proxy: {
      "/api": { target: gateway, changeOrigin: true, headers: devCookie, configure: ownPagesAreTheGateways },
      "/t3": { target: gateway, changeOrigin: true, ws: true, headers: devCookie, configure: ownPagesAreTheGateways },
    },
  },
});
