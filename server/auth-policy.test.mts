import assert from "node:assert/strict";
import { test } from "node:test";
import { LoginExpired, createLoginLimiter, mayEnter, trustLocalProcesses, type AuthFacts } from "./auth-policy.mts";

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

function limiter(extra: Parameters<typeof createLoginLimiter>[0] = {}) {
  const clock = { time: 1_000_000 };
  const slept: number[] = [];
  const logins = createLoginLimiter({ baseDelayMs: 100, maxDelayMs: 1_000, windowMs: 60_000, now: () => clock.time, sleep: async (ms) => { slept.push(ms); }, ...extra });
  const guess = async (caller: string, outcome: "ok" | "wrong" = "wrong") => { const attempt = logins.begin(caller)!; await attempt.wait(); attempt.done(outcome); };
  return { logins, clock, slept, guess };
}

test("wrong passwords make the next checks wait longer, up to a cap, and nobody is locked out", async () => {
  const { logins, clock, slept, guess } = limiter();
  for (let i = 0; i < 7; i++) await guess("a");
  assert.deepEqual(slept, [100, 200, 400, 800, 1_000, 1_000]);
  // After any number of wrong passwords the right one is still checked, only later.
  for (let i = 0; i < 100; i++) await guess("a");
  assert.notEqual(logins.begin("a"), null);
  assert.equal(logins.delayFor("a"), 1_000);
  clock.time += 60_001;
  assert.equal(logins.delayFor("a"), 0);
});

test("a caller that changes its address with every try slows everyone a little, and blocks nobody", async () => {
  const { logins, guess } = limiter();
  for (let i = 0; i < 40; i++) await guess(`made-up-${i}`);
  assert.equal(logins.delayFor("the-user"), 1_000);
  const attempt = logins.begin("the-user");
  assert.notEqual(attempt, null);
  // The right password clears that caller's own count.
  attempt!.done("ok");
  await guess("b"); await guess("b"); await guess("b", "ok");
  assert.equal(logins.delayFor("b"), logins.delayFor("never-seen"));
});

test("a place is taken at once, and only a few checks run together", () => {
  const { logins } = limiter();
  const first = logins.begin("a");
  assert.notEqual(first, null);
  // The same caller again, before the first finished, is told to try again: a burst cannot all get through.
  assert.equal(logins.begin("a"), null);
  const others = [logins.begin("b"), logins.begin("c")];
  assert.equal(others.includes(null), false);
  assert.equal(logins.begin("d"), null);
  first!.done("void");
  assert.notEqual(logins.begin("d"), null);
  // Giving a place back twice frees it once.
  first!.done("wrong");
  assert.equal(logins.begin("e"), null);
  assert.equal(logins.delayFor("a"), 0);
});

test("a caller that never finishes loses its place, cannot go on to a check, and is counted as wrong", async () => {
  const { logins } = limiter({ holdMs: 20 });
  const stalled = logins.begin("stalled")!;
  assert.equal(logins.begin("stalled"), null);
  assert.equal(logins.delayFor("stalled"), 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  // The place is free again, and holding it counted like a wrong password.
  assert.equal(logins.delayFor("stalled"), 100);
  const next = logins.begin("stalled");
  assert.notEqual(next, null);
  // The expired attempt wakes up late: it is refused before any password check.
  await assert.rejects(stalled.wait(), LoginExpired);
  // Its late result frees nothing a second time and is not counted twice.
  stalled.done("wrong");
  assert.equal(logins.begin("stalled"), null);
  assert.equal(logins.delayFor("stalled"), 100);
  next!.done("void");
  assert.notEqual(logins.begin("stalled"), null);
});

test("an attempt that expires while it waits its turn is stopped when the wait ends", async () => {
  let wake!: () => void;
  const { logins } = limiter({ holdMs: 20, sleep: () => new Promise<void>((resolve) => { wake = resolve; }) });
  const first = logins.begin("a")!; await first.wait(); first.done("wrong");
  const slow = logins.begin("a")!;
  const waiting = slow.wait();
  await new Promise((resolve) => setTimeout(resolve, 60));
  wake();
  await assert.rejects(waiting, LoginExpired);
});
