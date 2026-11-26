// The app's side of handoff proposals (behind the normal login): the card in a Bot's chat reads
// one, and the user approves or rejects it.
//   GET  /api/bots/:slug/handoffs                 this Bot's proposals, newest first
//   GET  /api/bots/:slug/handoffs/:id             one proposal, with the exact message it would send
//   POST /api/bots/:slug/handoffs/:id/approve     launch the stored message as a T3 thread
//   POST /api/bots/:slug/handoffs/:id/reject
// There is no route that edits a proposal: what was stored is what is shown and what is launched.
import type { IncomingHttpHeaders } from "node:http";
import type { HandoffProposal, Handoffs } from "./handoff.mts";

export type HandoffRequest = { method?: string; headers: IncomingHttpHeaders };

const LISTED = 30;

export function createHandoffRoutes<Req extends HandoffRequest, Res>({ handoffs, botExists, onDecided = () => {}, send, requireJson, checkOrigin, log = () => {} }: {
  handoffs: Handoffs;
  botExists: (slug: string) => Promise<boolean>;
  /** The card was answered (approved or rejected), here or on another device. */
  onDecided?: (proposal: HandoffProposal) => unknown;
  send: (res: Res, status: number, body: unknown, headers?: Record<string, string>) => void;
  requireJson: (req: Req) => void;
  checkOrigin: (req: Req) => boolean;
  log?: (line: string) => void;
}) {
  const noStore = { "cache-control": "no-store" };
  return {
    /** True when it answered the request. */
    async handle(req: Req, res: Res, url: URL): Promise<boolean> {
      const match = url.pathname.match(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/handoffs(?:\/([0-9a-f-]{36})(?:\/(approve|reject))?)?$/);
      if (!match) return false;
      const [, slug, id, action] = match;
      const method = req.method ?? "GET";
      try {
        if (method !== "GET") {
          requireJson(req);
          if (!checkOrigin(req)) return send(res, 403, { error: "forbidden origin" }), true;
        }
        if (!(await botExists(slug))) return send(res, 404, { error: "Bot not found" }), true;
        if (!id && method === "GET") {
          const proposals = (await handoffs.list(slug)).slice(0, LISTED).map(handoffs.view);
          return send(res, 200, { proposals }, noStore), true;
        }
        if (id && !action && method === "GET") return send(res, 200, handoffs.view(await handoffs.get(slug, id)), noStore), true;
        if (id && action && method === "POST") {
          const proposal = action === "approve" ? await handoffs.approve(slug, id) : await handoffs.reject(slug, id);
          log(`handoff: ${proposal.id} of bot ${slug} ${proposal.status}`);
          await Promise.resolve(onDecided(proposal)).catch(() => {});
          return send(res, 200, handoffs.view(proposal), noStore), true;
        }
        return send(res, 405, { error: "method not allowed" }), true;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!status) throw error;
        return send(res, status, { error: (error as Error).message }), true;
      }
    },
  };
}
