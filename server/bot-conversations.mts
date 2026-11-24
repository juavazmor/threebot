// A Bot's conversations: T3 threads in its own project, one of them active (`mainThreadId`).
//   GET    /api/bots/:slug/conversations                     the list, newest activity first
//   POST   /api/bots/:slug/conversations                     start a new one and make it active
//   POST   /api/bots/:slug/conversations/:threadId/activate  make an earlier one active again
//   DELETE /api/bots/:slug/conversations/:threadId           take a non-active one off the list (the T3 thread stays)
// The list is explicit: a Bot made from a project shares it with the user's own threads, and only the
// ones the Bot started (or was made with) are its conversations.
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { conversationIds, type Bot, type BotPatch } from "./main-bot.mts";
import { DEFAULT_MODEL } from "./provisioner.mts";

/** The fields of a T3 shell thread the list reads. */
export type ConversationShell = {
  id: string;
  title?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  latestUserMessageAt?: string | null;
  latestVisibleMessage?: { text?: string | null; updatedAt?: string | null } | null;
  archivedAt?: string | null;
};
export type ConversationView = {
  id: string;
  title: string;
  /** The latest message, cut short; a list of conversations all titled with the Bot's name needs it. */
  preview: string;
  createdAt: string | null;
  lastActivityAt: string | null;
  active: boolean;
  archived: boolean;
  /** T3 no longer lists the thread (deleted there); it can't be opened or made active. */
  missing: boolean;
};

/** What a new conversation's launch reads: the active one's settings, else the app's defaults. */
export type ConversationRpc = { call(tag: string, payload: object): Promise<unknown> };
type Projection = { thread?: { runtimeMode?: unknown; modelSelection?: unknown; interactionMode?: unknown } | null } | null;
export type ConversationDefaults = { runtimeMode: string; model?: unknown };

export function conversationList(bot: Pick<Bot, "mainThreadId" | "conversationThreadIds">, threads: ConversationShell[]): ConversationView[] {
  const byId = new Map(threads.map((thread) => [thread.id, thread]));
  const order = conversationIds(bot);
  const views = order.map((id): ConversationView => {
    const thread = byId.get(id);
    const lastActivityAt = [thread?.latestVisibleMessage?.updatedAt, thread?.latestUserMessageAt, thread?.createdAt]
      .filter((stamp): stamp is string => typeof stamp === "string" && !!stamp).sort().at(-1) ?? null;
    return {
      id,
      title: thread?.title?.trim() || "Conversation",
      preview: (thread?.latestVisibleMessage?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 140),
      createdAt: thread?.createdAt ?? null,
      lastActivityAt,
      active: id === bot.mainThreadId,
      archived: !!thread?.archivedAt,
      missing: !thread,
    };
  });
  // Ties (no messages yet) go to the conversation started last.
  return views.sort((a, b) => (b.lastActivityAt ?? "").localeCompare(a.lastActivityAt ?? "") || order.indexOf(b.id) - order.indexOf(a.id));
}

/**
 * Launches a new conversation in the Bot's project the way the provisioner launches a Bot's first one
 * (titled with its name, in the project's own folder), with the active conversation's model and
 * runtime mode, so a new conversation never changes what the Bot may do or which model answers.
 */
export async function launchConversation({ rpc, bot, defaults }: { rpc: ConversationRpc; bot: Bot; defaults: ConversationDefaults }): Promise<string> {
  if (!bot.projectId) throw Object.assign(new Error("This Bot has no T3 project yet."), { status: 409 });
  const projection = bot.mainThreadId
    ? (await rpc.call("orchestration.getThreadProjection", { threadId: bot.mainThreadId }).catch(() => null)) as Projection
    : null;
  const current = projection?.thread;
  const threadId = randomUUID();
  await rpc.call("orchestration.launchThread", {
    commandId: randomUUID(),
    threadId,
    projectId: bot.projectId,
    title: bot.name,
    modelSelection: current?.modelSelection ?? bot.model ?? defaults.model ?? DEFAULT_MODEL,
    runtimeMode: typeof current?.runtimeMode === "string" && current.runtimeMode ? current.runtimeMode : defaults.runtimeMode,
    interactionMode: "default",
    workspaceStrategy: { type: "root" },
  });
  return threadId;
}

export type ConversationsRequest = { method?: string; headers: IncomingHttpHeaders };

export function createConversationRoutes<Req extends ConversationsRequest, Res>({ getBot, update, rpc, threads, defaults, send, requireJson, checkOrigin, log = () => {} }: {
  getBot: (slug: string) => Promise<Bot | null>;
  /** The registry's read-modify-write save, so two changes never lose one another. */
  update: (slug: string, change: (bot: Bot) => BotPatch) => Promise<Bot>;
  rpc: ConversationRpc;
  /** T3's shell threads, for titles and times. */
  threads: () => Promise<ConversationShell[]>;
  defaults: () => Promise<ConversationDefaults>;
  send: (res: Res, status: number, body: unknown, headers?: Record<string, string>) => void;
  requireJson: (req: Req) => void;
  checkOrigin: (req: Req) => boolean;
  log?: (line: string) => void;
}) {
  const failure = (message: string, status: number) => Object.assign(new Error(message), { status });
  const noStore = { "cache-control": "no-store" };
  return {
    /** True when it answered the request. */
    async handle(req: Req, res: Res, url: URL): Promise<boolean> {
      const match = url.pathname.match(/^\/api\/bots\/([a-z0-9][a-z0-9-]{0,62})\/conversations(?:\/([^/]+)(\/activate)?)?$/);
      if (!match) return false;
      const [, slug, rawId, activate] = match;
      const threadId = rawId ? decodeURIComponent(rawId) : null;
      const method = req.method ?? "GET";
      try {
        if (method !== "GET") {
          requireJson(req);
          if (!checkOrigin(req)) return send(res, 403, { error: "forbidden origin" }), true;
        }
        return await route(res, slug, threadId, Boolean(activate), method);
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (!status) throw error;
        return send(res, status, { error: (error as Error).message }), true;
      }
    },
  };

  async function route(res: Res, slug: string, threadId: string | null, activate: boolean, method: string): Promise<boolean> {
    const bot = await getBot(slug);
    if (!bot) return send(res, 404, { error: "Bot not found" }), true;
    const listed = (candidate: Bot) => {
      if (!threadId || !conversationIds(candidate).includes(threadId)) throw failure("That isn't one of this Bot's conversations.", 404);
      return threadId;
    };
    if (!threadId && method === "GET") {
      return send(res, 200, { conversations: conversationList(bot, await threads()) }, noStore), true;
    }
    if (!threadId && method === "POST") {
      if (bot.environmentId !== "local") return send(res, 409, { error: "New conversations are only available for Bots on this machine." }), true;
      const created = await launchConversation({ rpc, bot, defaults: await defaults() });
      // Through the registry, so AGENTS.md names the new active conversation.
      const saved = await update(slug, (current) => ({ conversationThreadIds: [...conversationIds(current), created], mainThreadId: created }));
      log(`bots: ${slug} started a new conversation`);
      return send(res, 200, saved, noStore), true;
    }
    if (threadId && activate && method === "POST") {
      const id = listed(bot);
      if ((await threads()).every((thread) => thread.id !== id)) return send(res, 409, { error: "T3 no longer has that conversation." }), true;
      return send(res, 200, await update(slug, (current) => ({ mainThreadId: listed(current) })), noStore), true;
    }
    if (threadId && !activate && method === "DELETE") {
      const saved = await update(slug, (current) => {
        const id = listed(current);
        if (id === current.mainThreadId) throw failure("Switch to another conversation before removing this one.", 409);
        return { conversationThreadIds: conversationIds(current).filter((candidate) => candidate !== id) };
      });
      return send(res, 200, saved, noStore), true;
    }
    return send(res, 405, { error: "method not allowed" }), true;
  }
}
