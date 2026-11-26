import assert from "node:assert/strict";
import { test } from "node:test";
import { createLoginLimiter, mayEnter, trustLocalProcesses, type AuthFacts } from "./auth-policy.mts";

const facts = (extra: Partial<AuthFacts> = {}): AuthFacts => ({
  tailnet: false, tailnetUser: false, accessConfigured: false, accessVerified: false, passwordSet: true, session: false, trustLocal: false, ...extra,
});

test("with a password, only a session made with it gets in", () => {
  assert.equal(mayEnter(facts()), false);
  assert.equal(mayEnter(facts({ session: true })), true);
});

test("a Tailscale login alone is not the user: any local client can send that header", () => {
  const onTailnet = { tailnet: true, tailnetUser: true };
  assert.equal(mayEnter(facts(onTailnet)), false);
  assert.equal(mayEnter(facts({ ...onTailnet, session: true })), true);
  // The session alone is not enough there either: the tailnet lets in listed users only.
  assert.equal(mayEnter(facts({ tailnet: true, tailnetUser: false, session: true })), false);
  // Cloudflare tokens never count on the tailnet port.
  assert.equal(mayEnter(facts({ tailnet: true, tailnetUser: false, accessConfigured: true, accessVerified: true })), false);
});

test("a server with no password answers nobody, on any port", () => {
  assert.equal(mayEnter(facts({ passwordSet: false })), false);
  assert.equal(mayEnter(facts({ passwordSet: false, session: true })), false);
  assert.equal(mayEnter(facts({ passwordSet: false, tailnet: true, tailnetUser: true })), false);
  assert.equal(mayEnter(facts({ passwordSet: false, tailnet: true, tailnetUser: true, session: true })), false);
});

test("trusting local processes is an explicit choice, and it only replaces a missing password", () => {
  assert.equal(trustLocalProcesses({}), false);
  assert.equal(trustLocalProcesses({ THREEBOT_TRUST_LOCAL: "1" }), false);
  assert.equal(trustLocalProcesses({ THREEBOT_TRUST_LOCAL: "true" }), true);
  const trusting = { trustLocal: true };
  assert.equal(mayEnter(facts({ ...trusting, passwordSet: false })), true);
  assert.equal(mayEnter(facts({ ...trusting, passwordSet: false, tailnet: true, tailnetUser: true })), true);
  assert.equal(mayEnter(facts({ ...trusting, passwordSet: false, tailnet: true, tailnetUser: false })), false);
  // Once there is a password, it is required again.
  assert.equal(mayEnter(facts({ ...trusting })), false);
  assert.equal(mayEnter(facts({ ...trusting, tailnet: true, tailnetUser: true })), false);
  // With Cloudflare Access set up, the open port is not open.
  assert.equal(mayEnter(facts({ ...trusting, passwordSet: false, accessConfigured: true })), false);
});

test("a valid Cloudflare Access token gets in without the password", () => {
  assert.equal(mayEnter(facts({ accessConfigured: true, accessVerified: true })), true);
  assert.equal(mayEnter(facts({ accessConfigured: true, accessVerified: false })), false);
});

test("wrong passwords are limited per caller and overall, for a window", () => {
  const clock = { time: 1_000_000 };
  const limiter = createLoginLimiter({ perCaller: 3, overall: 5, windowMs: 60_000, now: () => clock.time });
  for (let i = 0; i < 3; i++) { assert.equal(limiter.blocked("a"), false); limiter.failed("a"); }
  assert.equal(limiter.blocked("a"), true);
  assert.equal(limiter.blocked("b"), false);
  // A caller that changes its address with every try runs into the overall limit.
  limiter.failed("b"); limiter.failed("c");
  assert.equal(limiter.blocked("never-seen"), true);
  clock.time += 60_001;
  assert.equal(limiter.blocked("a"), false);
  assert.equal(limiter.blocked("never-seen"), false);
  // The right password clears that caller's own count.
  limiter.failed("d"); limiter.failed("d"); limiter.succeeded("d"); limiter.failed("d");
  assert.equal(limiter.blocked("d"), false);
});
