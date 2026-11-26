import assert from "node:assert/strict";
import { test } from "node:test";
import { allowedOrigins, sameOriginRequest } from "./request-origin.mts";

const request = (headers: Record<string, string>) => ({ headers: { host: "bot.swk.tools", ...headers } });

test("the app's own pages are allowed", () => {
  assert.equal(sameOriginRequest(request({ origin: "https://bot.swk.tools" })), true);
});

test("other websites are refused, including lookalikes and opaque origins", () => {
  for (const origin of ["https://example.com", "https://bot.swk.tools.evil.example", "https://evil.example/bot.swk.tools", "null", "file://", ""]) {
    assert.equal(sameOriginRequest(request({ origin })), false, origin);
  }
});

test("a browser request marked cross-site is refused even without an Origin", () => {
  assert.equal(sameOriginRequest(request({ "sec-fetch-site": "cross-site" })), false);
  assert.equal(sameOriginRequest(request({ "sec-fetch-site": "same-origin" })), true);
});

test("non-browser clients send no Origin and still depend on their credential", () => {
  assert.equal(sameOriginRequest(request({})), true);
});

test("another page on this machine is another site, whatever its port", () => {
  const local = (origin: string) => sameOriginRequest({ headers: { host: "127.0.0.1:3780", origin } });
  assert.equal(local("http://127.0.0.1:3780"), true);
  for (const origin of ["http://127.0.0.1:5173", "http://localhost:3780", "http://localhost:5173", "http://[::1]:3780", "https://127.0.0.1:3780.evil.example"]) {
    assert.equal(local(origin), false, origin);
  }
  // A dev server on another port is named explicitly.
  assert.equal(sameOriginRequest({ headers: { host: "127.0.0.1:3780", origin: "http://localhost:5180" } }, { allowed: allowedOrigins({ ALLOWED_ORIGINS: "http://localhost:5180" }) }), true);
});

test("extra origins are explicit", () => {
  const allowed = allowedOrigins({ ALLOWED_ORIGINS: "https://app.example, https://two.example" });
  assert.equal(sameOriginRequest(request({ origin: "https://two.example" }), { allowed }), true);
  assert.equal(sameOriginRequest(request({ origin: "https://three.example" }), { allowed }), false);
  assert.equal(allowedOrigins({}).size, 0);
});
