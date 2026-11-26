import { apiRequest } from "./api";
import { resultObject } from "./botMessages";

// A handoff proposal: a Bot asks, with a card in its chat, to start a coding thread for one of the
// user's projects. The gateway keeps the proposal; the chat only knows its id (from the Bot's
// handoff_propose call) and reads everything it shows from the gateway.

export type HandoffStatus = "pending" | "launching" | "launched" | "rejected" | "expired" | "invalid" | "failed";
export type HandoffProposal = {
  id: string;
  botSlug: string;
  botName: string;
  threadId: string;
  projectId: string;
  projectTitle: string;
  projectPath: string;
  kind: string;
  kindLabel: string;
  url: string;
  /** The launched thread's title and first message, exactly as the gateway will send them. */
  title: string;
  prompt: string;
  status: HandoffStatus;
  createdAt: string;
  decidedAt?: string;
  /** When Approve last sent the launch; T3 has not confirmed it yet. */
  launchingAt?: string;
  launchedThreadId?: string;
  lastError?: string;
  invalidReason?: string;
  launchSettings: { runtimeMode: string; interactionMode: string; workspaceStrategy: { type: string } };
  /** The isolated folder the thread runs in; it reads the project at projectPath. */
  evaluatorDir: string | null;
};

const base = (slug: string, id: string) => `/api/bots/${encodeURIComponent(slug)}/handoffs/${encodeURIComponent(id)}`;

export const handoffApi = {
  get: (slug: string, id: string) => apiRequest<HandoffProposal>(base(slug, id), { cache: "no-store" }),
  approve: (slug: string, id: string) => apiRequest<HandoffProposal>(`${base(slug, id)}/approve`, { method: "POST", body: "{}" }),
  reject: (slug: string, id: string) => apiRequest<HandoffProposal>(`${base(slug, id)}/reject`, { method: "POST", body: "{}" }),
  /** Only for a launch T3 has not confirmed; the gateway asks T3 first. */
  fail: (slug: string, id: string) => apiRequest<HandoffProposal>(`${base(slug, id)}/fail`, { method: "POST", body: "{}" }),
};

/** The Bots' own MCP server's tool, as Claude and Codex name it; a same-named tool elsewhere is not it. */
export const HANDOFF_TOOL_NAMES = ["mcp__bot__handoff_propose", "bot.handoff_propose"];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The proposal a completed handoff_propose call made, from the tool's result; null for an error. */
export function handoffProposalId(output: unknown): string | null {
  let result = resultObject(output);
  // A harness may keep the tool's text as one string instead of structured content or text blocks.
  if (result && result.proposed === undefined && typeof result.content === "string") result = resultObject(result.content);
  if (result?.proposed !== true || typeof result.proposalId !== "string" || !UUID.test(result.proposalId)) return null;
  return result.proposalId;
}

export function handoffStatusLabel(status: HandoffStatus): string {
  switch (status) {
    case "pending": return "Waiting for you";
    case "launching": return "Checking T3";
    case "launched": return "Approved";
    case "rejected": return "Rejected";
    case "invalid": return "No longer valid";
    case "failed": return "Marked as failed";
    default: return "Expired";
  }
}

/**
 * How the thread would run, in words: the card says what approving starts. The gateway's one
 * combination is described by what it does; anything else is named as T3 names it.
 */
export function handoffRunsAs(settings: HandoffProposal["launchSettings"]): string {
  if (settings.interactionMode === "plan" && settings.runtimeMode === "approval-required") return "Plan mode: it reads the approved copy of the project and the web without asking, and it can send what it reads to the web; it asks before editing files or running other threads";
  return `${settings.interactionMode} mode, ${settings.runtimeMode}`;
}

/** Where the thread runs: the evaluator folder, reading the project at its path. */
export function handoffRunsIn(proposal: Pick<HandoffProposal, "evaluatorDir" | "projectPath" | "launchSettings">): string {
  if (proposal.evaluatorDir) return `The isolated evaluator folder ${proposal.evaluatorDir}, reading the project at ${proposal.projectPath}`;
  return proposal.launchSettings.workspaceStrategy.type === "root" ? "The project's folder" : "A new worktree";
}

const LONG_URL = 200;

/** What about the link deserves a second look before approving: length and a query string. */
export function handoffUrlWarning(url: string): string | null {
  let query = false;
  try { query = new URL(url).search.length > 1; } catch { /* shown as it is */ }
  const long = url.length > LONG_URL;
  if (!long && !query) return null;
  const parts = [long ? `is ${url.length} characters long` : "", query ? "has a query string (the part after ?)" : ""].filter(Boolean);
  return `Check the link before approving: it ${parts.join(" and ")}, which can carry text the thread will read.`;
}
