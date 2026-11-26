// handoff_propose on the Bots' own MCP server ("bot"): the one way a Bot that reads untrusted
// content can ask for work in a coding project. The Bot is whoever its bearer says it is, the
// fields are closed (no free text), and the tool only stores a proposal for the user to approve.
// A Bot with no entry in the allowlist is never shown the tool and cannot call it.
import { HANDOFF_KINDS, MAX_URL_LENGTH, normalizeHandoffUrl, type HandoffKind, type HandoffProposal, type HandoffTarget, type Handoffs } from "./handoff.mts";
import type { ExtraTools, McpAuth, ToolResult } from "./vault-mcp.mts";

export const HANDOFF_TOOL = "handoff_propose";
const FIELDS = ["projectId", "url", "kind", "threadId"] as const;

const toolError = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });
// The result also goes as structured content: T3 keeps that as an object, whatever it does with the text.
const toolJson = (value: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }], structuredContent: value });

export function handoffToolDefinition(targets: HandoffTarget[]) {
  return {
    name: HANDOFF_TOOL,
    title: "Propose a handoff to a coding project",
    description:
      "Propose that a coding thread evaluates a link for one of the user's projects. You only propose: the user sees a card in this chat with the exact message, and nothing starts unless they approve it. " +
      "You cannot add text, edit or cancel a proposal, and you are not told the outcome. Use it when the user asks you to pass a link on to a project, once per link; then tell them the card is waiting. " +
      `Projects you may propose to: ${targets.map((target) => `${target.projectId} (${target.title})`).join("; ") || "none available right now"}.`,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        projectId: { type: "string", enum: targets.map((target) => target.projectId), description: "The T3 project to evaluate the link for." },
        url: { type: "string", maxLength: MAX_URL_LENGTH, description: "The link, https only, with no username, password or port." },
        kind: { type: "string", enum: [...HANDOFF_KINDS], description: "evaluate-fit: evaluate whether this tool, library or idea fits the project, or whether what it already has is enough." },
        threadId: { type: "string", description: "The T3 thread id of the conversation you are running in (your active one is in AGENTS.md, or mainThreadId in .bot/bot.json). The card shows there." },
      },
      required: [...FIELDS],
    },
  };
}

/**
 * The handoff tool for one caller, or null when that caller may not hand off at all: the legacy
 * shared bearer (it names no Bot) and any Bot without an allowlist entry.
 */
export function createHandoffTools({ handoffs, projects, onProposed = () => {}, log = () => {} }: {
  handoffs: Handoffs;
  /** T3 projects a handoff may target: live ones that are not a Bot's own folder. */
  projects: () => Promise<HandoffTarget[]>;
  /** A new card is waiting (not called for a repeated proposal). */
  onProposed?: (proposal: HandoffProposal) => unknown;
  log?: (line: string) => void;
}) {
  return async function handoffTools(auth: McpAuth): Promise<ExtraTools | null> {
    const slug = auth.legacy ? null : auth.botSlug;
    if (!slug) return null;
    const allowed = await handoffs.allowedProjects(slug);
    if (allowed.length === 0) return null;
    // Titles for the tool's description; without T3 the ids alone still work.
    const known = await projects().catch(() => null);
    const targets = known ? known.filter((project) => allowed.includes(project.projectId)) : allowed.map((projectId) => ({ projectId, title: projectId, path: "" }));
    return {
      tools: [handoffToolDefinition(targets)],
      instructions: "handoff_propose asks the user, with a card in your chat, to start a coding thread that evaluates a link for one of their projects. It is the only way you hand work to a project.",
      async call(name, args, { botFor }): Promise<ToolResult> {
        if (name !== HANDOFF_TOOL) return toolError(`Unknown tool ${name}`);
        try {
          const extra = Object.keys(args ?? {}).filter((key) => !(FIELDS as readonly string[]).includes(key));
          if (extra.length) return toolError(`Unknown field: ${extra.join(", ")}. handoff_propose takes only ${FIELDS.join(", ")}.`);
          const bot = await botFor(args.threadId) as { slug: string; name?: string };
          if (bot.slug !== slug) return toolError("That threadId belongs to another Bot.");
          if (!(HANDOFF_KINDS as readonly unknown[]).includes(args.kind)) return toolError(`kind must be one of: ${HANDOFF_KINDS.join(", ")}.`);
          // Asked again here: the list may have changed since this session listed its tools.
          const current = await handoffs.allowedProjects(slug);
          if (typeof args.projectId !== "string" || !current.includes(args.projectId)) {
            log(`handoff: refused project for bot ${slug}`);
            return toolError(`projectId must be one of the projects you may propose to: ${current.join(", ") || "none"}.`);
          }
          const url = normalizeHandoffUrl(args.url);
          const project = (await projects()).find((candidate) => candidate.projectId === args.projectId);
          if (!project) return toolError("That project is not available in T3 right now (archived, deleted or T3 is unreachable).");
          const { proposal, deduped } = await handoffs.propose({ bot: { slug, name: bot.name ?? slug }, threadId: args.threadId, project, kind: args.kind as HandoffKind, url });
          if (!deduped) {
            log(`handoff: bot ${slug} proposed ${proposal.kind} for project ${proposal.projectId} (${proposal.id})`);
            await Promise.resolve(onProposed(proposal)).catch(() => {});
          }
          return toolJson({
            proposed: true,
            proposalId: proposal.id,
            status: "waiting-for-user",
            alreadyWaiting: deduped,
            note: "The user now sees a card in this chat to approve or reject. You cannot change or cancel it and you will not be told the outcome. Tell the user the card is waiting, and do not propose this link again.",
          });
        } catch (error) {
          return toolError(String((error as { message?: unknown } | null)?.message ?? error));
        }
      },
    };
  };
}
