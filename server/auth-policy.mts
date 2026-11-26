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

/** A sign-in that held its place too long: it is over, and must not go on to check a password. */
export class LoginExpired extends Error {
  constructor() { super("That sign-in took too long. Try again."); }
}

/**
 * One sign-in being checked. `wait` holds it back by what earlier wrong passwords earned, and
 * throws LoginExpired when the attempt lost its place meanwhile; call it right before the check.
 */
export type LoginAttempt = {
  wait(): Promise<void>;
  /** Frees its place. "wrong" counts against later attempts; "void" is one that never checked a password. */
  done(outcome: "ok" | "wrong" | "void"): void;
};

/**
 * Slows password guessing without giving anyone a switch that locks the user out. A local caller
 * can claim any address, so nothing here blocks for minutes: wrong passwords make the next checks
 * wait, doubling up to a few seconds, for that caller and (more slowly) for everyone, and only a
 * few checks run at once. A place is taken before any waiting, so a burst cannot slip past.
 */
export function createLoginLimiter({ perCaller = 1, overall = 3, baseDelayMs = 250, maxDelayMs = 3_000, windowMs = 15 * 60_000, holdMs = 20_000, now = () => Date.now(), sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)) }: {
  /** Checks one caller may have running, and all callers together; more are told to try again. */
  perCaller?: number; overall?: number;
  baseDelayMs?: number; maxDelayMs?: number; windowMs?: number;
  /** A place not given back within this time (a caller that stopped sending) is freed, and that attempt is over. */
  holdMs?: number;
  now?: () => number; sleep?: (ms: number) => Promise<void>;
} = {}) {
  const wrong = new Map<string, number[]>();
  const running = new Map<string, number>();
  let runningAll = 0;
  const fresh = (times: number[] | undefined) => (times ?? []).filter((time) => now() - time < windowMs);
  const delayFor = (caller: string) => {
    let everyone = 0;
    for (const times of wrong.values()) everyone += fresh(times).length;
    // A caller that changes its address with every try still meets everyone's count.
    const steps = Math.max(fresh(wrong.get(caller)).length, Math.floor(everyone / 4));
    return steps === 0 ? 0 : Math.min(maxDelayMs, baseDelayMs * 2 ** (steps - 1));
  };
  return {
    delayFor,
    /** Takes a place for this caller, or null when too many checks are already running. Never waits. */
    begin(caller: string): LoginAttempt | null {
      if ((running.get(caller) ?? 0) >= perCaller || runningAll >= overall) return null;
      running.set(caller, (running.get(caller) ?? 0) + 1);
      runningAll++;
      // open: holding its place. expired: the place went to someone else and this attempt is over.
      let state: "open" | "expired" | "closed" = "open";
      const release = () => {
        runningAll--;
        const left = (running.get(caller) ?? 1) - 1;
        if (left > 0) running.set(caller, left); else running.delete(caller);
      };
      const recordWrong = () => {
        for (const [key, times] of wrong) { const kept = fresh(times); if (kept.length) wrong.set(key, kept); else wrong.delete(key); }
        // Made-up addresses must not grow this without bound: the oldest callers go first.
        while (wrong.size >= 2_000) wrong.delete(wrong.keys().next().value!);
        wrong.set(caller, [...(wrong.get(caller) ?? []), now()]);
      };
      const attempt: LoginAttempt = {
        async wait() {
          const ms = delayFor(caller);
          if (ms) await sleep(ms);
          if (state !== "open") throw new LoginExpired();
        },
        done(outcome) {
          if (state === "closed") return;
          const held = state === "open";
          state = "closed";
          clearTimeout(expiry);
          if (held) release();
          // An attempt that expired was already counted as wrong; a late "wrong" is not counted twice.
          if (outcome === "ok") wrong.delete(caller);
          else if (outcome === "wrong" && held) recordWrong();
        },
      };
      // Holding a place without finishing is not free: it counts like a wrong password.
      const expiry = setTimeout(() => {
        if (state !== "open") return;
        state = "expired";
        release();
        recordWrong();
      }, holdMs);
      expiry.unref?.();
      return attempt;
    },
  };
}
