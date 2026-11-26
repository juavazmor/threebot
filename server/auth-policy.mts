// Who may use the app. Agents run on the same machine as the gateway, as the same user, with a
// browser of their own, so nothing a local process can present by itself counts as the user: not
// reaching a loopback port, and not a `Tailscale-User-Login` header, which any local client can
// send to the tailnet listener directly. The user is whoever holds a session made with the
// password, or a Cloudflare Access token. A server with neither answers nobody, unless it was
// started with THREEBOT_TRUST_LOCAL=true (development and tests, where every local process is trusted).

export type AuthFacts = {
  /** The request arrived on the listener `tailscale serve` proxies to. */
  tailnet: boolean;
  /** Its `Tailscale-User-Login` is on the allowed list. Only read when `tailnet`. */
  tailnetUser: boolean;
  /** Cloudflare Access is set up, and whether this request carries a valid token for an allowed email. */
  accessConfigured: boolean;
  accessVerified: boolean;
  /** A password exists (BOT_PASSWORD, or one set in the app or with `threebot password`). */
  passwordSet: boolean;
  /** The request carries a valid session cookie. */
  session: boolean;
  trustLocal: boolean;
};

export function mayEnter(facts: AuthFacts): boolean {
  // On the tailnet the header says who Tailscale thinks is asking; the session says it is the user.
  if (facts.tailnet) return facts.tailnetUser && (facts.passwordSet ? facts.session : facts.trustLocal);
  if (facts.accessVerified) return true;
  if (facts.passwordSet) return facts.session;
  return !facts.accessConfigured && facts.trustLocal;
}

export const trustLocalProcesses = (env = process.env): boolean => env.THREEBOT_TRUST_LOCAL === "true";

/**
 * Failed sign-ins, counted per caller and overall. The caller's address comes from a proxy header
 * that a local client can make up, so the overall count is what bounds guessing; it also means a
 * burst of wrong passwords holds everyone's sign-in for the window. Open sessions are not affected.
 */
export function createLoginLimiter({ perCaller = 5, overall = 30, windowMs = 15 * 60_000, now = () => Date.now() }: { perCaller?: number; overall?: number; windowMs?: number; now?: () => number } = {}) {
  const byCaller = new Map<string, number[]>();
  const fresh = (times: number[]) => times.filter((time) => now() - time < windowMs);
  const total = () => [...byCaller.values()].reduce((sum, times) => sum + fresh(times).length, 0);
  return {
    blocked(caller: string): boolean {
      return fresh(byCaller.get(caller) ?? []).length >= perCaller || total() >= overall;
    },
    failed(caller: string) {
      for (const [key, times] of byCaller) {
        const kept = fresh(times);
        if (kept.length) byCaller.set(key, kept); else byCaller.delete(key);
      }
      byCaller.set(caller, [...(byCaller.get(caller) ?? []), now()]);
    },
    /** A correct password clears that caller's count; the overall one runs out by itself. */
    succeeded(caller: string) {
      byCaller.delete(caller);
    },
  };
}
