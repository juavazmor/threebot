import { apiRequest } from "./api";

// A handoff proposal: a Bot asks, with a card in its chat, to start a coding thread for one of the
// user's projects. The gateway keeps the proposal; the chat only knows its id (from the Bot's
// handoff_propose call) and reads everything it shows from the gateway.

export type HandoffStatus = "pending" | "launched" | "rejected" | "expired";
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
  launchedThreadId?: string;
  lastError?: string;
  launchSettings: { runtimeMode: string; interactionMode: string; workspaceStrategy: { type: string } };
};

const base = (slug: string, id: string) => `/api/bots/${encodeURIComponent(slug)}/handoffs/${encodeURIComponent(id)}`;

export const handoffApi = {
  get: (slug: string, id: string) => apiRequest<HandoffProposal>(base(slug, id), { cache: "no-store" }),
  approve: (slug: string, id: string) => apiRequest<HandoffProposal>(`${base(slug, id)}/approve`, { method: "POST", body: "{}" }),
  reject: (slug: string, id: string) => apiRequest<HandoffProposal>(`${base(slug, id)}/reject`, { method: "POST", body: "{}" }),
};

/** The proposal a completed handoff_propose call made, from the tool's output text. */
export function handoffProposalId(output: string): string | null {
  if (!/"proposed"\s*:\s*true/.test(output)) return null;
  return /"proposalId"\s*:\s*"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"/.exec(output)?.[1] ?? null;
}

export function handoffStatusLabel(status: HandoffStatus): string {
  return status === "pending" ? "Waiting for you" : status === "launched" ? "Approved" : status === "rejected" ? "Rejected" : "Expired";
}

/**
 * How the thread would run, in words: the card says what approving starts. The gateway's one
 * combination is described by what it does; anything else is named as T3 names it.
 */
export function handoffRunsAs(settings: HandoffProposal["launchSettings"]): string {
  const where = settings.workspaceStrategy.type === "root" ? "in the project's folder" : "in a new worktree";
  if (settings.interactionMode === "plan" && settings.runtimeMode === "approval-required") return `Plan mode: it reads and looks things up on its own, and asks before any change, ${where}`;
  return `${settings.interactionMode} mode, ${settings.runtimeMode}, ${where}`;
}
