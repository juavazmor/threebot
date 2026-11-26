// The gateway's side of launching an approved handoff: the evaluator folder every handoff thread
// runs in and its T3 project, the target checked again at approval, and the questions that settle
// a launch T3 did not confirm. handoff.mts keeps the state machine and asks through here.
//   - The evaluator folder is made and hardened by hand (its .claude/settings.json holds the OS
//     sandbox and deny rules); without both, and without each rule evaluatorSettingsGaps checks,
//     handoffs are refused rather than run unhardened.
//   - Its T3 project is found by folder, or made the way the provisioner makes a Bot's project,
//     without creating the folder.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { samePath, within } from "./adopted-bots.mts";
import { launchHandoffThread, pickHandoffModel, type HandoffLauncher, type HandoffProposal, type HandoffRpc, type HandoffTarget } from "./handoff.mts";
import { SnapshotError, ensureSnapshot, resolveCommit, snapshotPath, sweepSnapshots } from "./handoff-snapshot.mts";

export const EVALUATOR_PROJECT_TITLE = "Handoff evaluator";

/** A T3 project as /api/projects lists it; only the fields used here. */
export type HandoffT3Project = { id: string; title?: string; workspaceRoot?: string; deletedAt?: string | null; archivedAt?: string | null; defaultModelSelection?: unknown };

const QUERY_MS = 15_000;
const LAUNCH_MS = 30_000;

function timed<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([promise, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * Whether T3 itself answered a call with a failure (T3Client attaches T3's encoded cause), as
 * opposed to a timeout or a dropped socket, after which the call may still have gone through.
 */
export function t3Refused(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause as { _tag?: unknown; failures?: unknown } | unknown[] | null | undefined;
  const reasons = Array.isArray(cause) ? cause : Array.isArray((cause as { failures?: unknown })?.failures) ? (cause as { failures: unknown[] }).failures : cause ? [cause] : [];
  return reasons.length > 0 && reasons.every((reason) => (reason as { _tag?: unknown } | null)?._tag === "Fail");
}

/** Deny rules the evaluator's settings must hold: no shell, no file changes, no Bot tools, no messaging other threads. */
export const EVALUATOR_DENY = ["Bash", "Edit", "Write", "mcp__bot__*", "mcp__t3-code__t3_thread_send"] as const;

/**
 * What the evaluator's .claude/settings.json is missing to count as hardened, given its text: the
 * OS sandbox on and required with the home folder unreadable, no unsandboxed commands, reads kept to
 * its own folder, no hooks, the deny rules, no bypass mode, and nothing that widens any of it (allow
 * rules, extra folders, read exceptions). Empty when nothing is missing.
 */
export function evaluatorSettingsGaps(text: string): string[] {
  let settings: unknown;
  try { settings = JSON.parse(text); } catch { return ["valid JSON"]; }
  const object = (value: unknown) => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const sandbox = object(object(settings).sandbox);
  const permissions = object(object(settings).permissions);
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];
  const filesystem = object(sandbox.filesystem);
  const denyRead = Array.isArray(filesystem.denyRead) ? filesystem.denyRead : [];
  // Absent or an empty list: anything else could open what the rest closes.
  const empty = (value: unknown) => value === undefined || (Array.isArray(value) && value.length === 0);
  return [
    sandbox.enabled === true ? "" : "sandbox.enabled: true",
    sandbox.failIfUnavailable === true ? "" : "sandbox.failIfUnavailable: true",
    sandbox.allowUnsandboxedCommands === false ? "" : "sandbox.allowUnsandboxedCommands: false",
    ...EVALUATOR_DENY.map((rule) => deny.includes(rule) ? "" : `permissions.deny "${rule}"`),
    permissions.disableBypassPermissionsMode === "disable" ? "" : `permissions.disableBypassPermissionsMode: "disable"`,
    permissions.blockReadsOutsideWorkingDirectories === true ? "" : "permissions.blockReadsOutsideWorkingDirectories: true",
    object(settings).disableAllHooks === true ? "" : "disableAllHooks: true",
    denyRead.includes("~/") ? "" : `sandbox.filesystem.denyRead "~/"`,
    empty(permissions.allow) ? "" : "no permissions.allow rules",
    empty(permissions.additionalDirectories) ? "" : "no permissions.additionalDirectories",
    filesystem.allowRead === undefined ? "" : "no sandbox.filesystem.allowRead",
  ].filter(Boolean);
}

/** Why handoffs can't run with this evaluator folder, or null when it and its hardened settings exist. */
export async function evaluatorProblem(dir: string): Promise<string | null> {
  const settingsFile = path.join(dir, ".claude", "settings.json");
  let isDir = false;
  try { isDir = (await fs.stat(dir)).isDirectory(); } catch { /* missing */ }
  let text: string | null = null;
  try { if ((await fs.stat(settingsFile)).isFile()) text = await fs.readFile(settingsFile, "utf8"); } catch { /* missing or unreadable */ }
  if (!isDir || text === null) return `Handoffs are turned off: the evaluator folder ${dir} or its .claude/settings.json is missing.`;
  const gaps = evaluatorSettingsGaps(text);
  if (gaps.length) return `Handoffs are turned off: the evaluator's .claude/settings.json is not hardened; it needs ${gaps.join(", ")}.`;
  return null;
}

const NOT_FOUND_DEPTH = 8;

/**
 * T3's answer for a thread it does not have (checked on 0.1.12): every reason a Fail whose error is
 * an OrchestrationV2GetThreadProjectionError, and whose chain of causes (error.cause, .cause.cause,
 * ...) reaches a ProjectionStoreThreadNotFoundError by name. Matched by structure, so another
 * failure that merely mentions those words in a message is not "not found".
 */
export function threadNotFound(error: unknown): boolean {
  const cause = (error as { cause?: unknown } | null)?.cause;
  const reasons = Array.isArray(cause) ? cause : Array.isArray((cause as { failures?: unknown } | null)?.failures) ? (cause as { failures: unknown[] }).failures : cause ? [cause] : [];
  return reasons.length > 0 && reasons.every((reason) => {
    const { _tag, error: failed } = (reason ?? {}) as { _tag?: unknown; error?: { _tag?: unknown; cause?: unknown } };
    if (_tag !== "Fail" || failed?._tag !== "OrchestrationV2GetThreadProjectionError") return false;
    let link = failed.cause as { name?: unknown; _tag?: unknown; cause?: unknown } | null | undefined;
    for (let depth = 0; depth < NOT_FOUND_DEPTH && link && typeof link === "object"; depth++, link = link.cause as typeof link) {
      if (link.name === "ProjectionStoreThreadNotFoundError" || link._tag === "ProjectionStoreThreadNotFoundError") return true;
    }
    return false;
  });
}

/** `sent`: T3 itself answered the launch with a failure; false when the launch was never sent. */
const refused = (error: unknown, sent: boolean) => Object.assign(error instanceof Error ? error : new Error(String(error)), { refused: true, sent });

export function createHandoffLauncher({ evaluatorDir, rpc, projects, eligible, models }: {
  /** Absolute; HANDOFF_EVALUATOR_DIR. */
  evaluatorDir: string;
  rpc: HandoffRpc;
  /** T3's projects that are not deleted (archived ones included). */
  projects: () => Promise<HandoffT3Project[]>;
  /** T3 projects a handoff may target before the evaluator is taken out: live, not a Bot. */
  eligible: () => Promise<HandoffTarget[]>;
  /** T3's providers and the app's default model, for pickHandoffModel; `fallback` is Claude. */
  models: () => Promise<{ providers: unknown; appDefault: unknown; fallback: unknown }>;
}): HandoffLauncher & { targets: () => Promise<HandoffTarget[]> } {
  const isEvaluator = (folder: string) => within(evaluatorDir, folder);
  /** Eligible targets: never the evaluator's own folder or anything in it. */
  const targets = async () => (await eligible()).filter((target) => !isEvaluator(target.path));

  // One lookup or creation at a time, so two approvals at once make one evaluator project.
  let lock: Promise<unknown> = Promise.resolve();
  function evaluatorProject(model: unknown): Promise<string> {
    const result = lock.then(async () => {
      const found = (await projects()).find((project) => !project.archivedAt && !project.deletedAt && project.workspaceRoot && samePath(project.workspaceRoot, evaluatorDir));
      if (found) return found.id;
      const projectId = randomUUID();
      await timed(rpc.call("projects.mutate", {
        type: "project.create",
        commandId: randomUUID(),
        projectId,
        title: EVALUATOR_PROJECT_TITLE,
        workspaceRoot: evaluatorDir,
        createWorkspaceRootIfMissing: false,
        defaultModelSelection: model,
      }), QUERY_MS, "T3 timed out creating the evaluator project");
      return projectId;
    });
    lock = result.catch(() => {});
    return result;
  }

  return {
    evaluatorDir,
    targets,
    unavailable: () => evaluatorProblem(evaluatorDir),

    async invalidTarget(proposal: HandoffProposal) {
      const [all, current] = await Promise.all([projects(), targets()]);
      const project = all.find((candidate) => candidate.id === proposal.projectId);
      if (!project) return "the project is no longer in T3";
      if (project.archivedAt) return "the project was archived in T3";
      const target = current.find((candidate) => candidate.projectId === proposal.projectId);
      if (!target) return "the project is no longer one a handoff may target";
      if (!samePath(target.path, proposal.projectPath)) return "the project's folder changed since the proposal";
      return null;
    },

    async launch(proposal: HandoffProposal) {
      let projectId: string;
      let modelSelection: unknown;
      // Everything before the launch call itself can fail without a thread existing.
      try {
        const [all, { providers, appDefault, fallback }] = await Promise.all([projects(), models()]);
        const target = all.find((candidate) => candidate.id === proposal.projectId);
        modelSelection = pickHandoffModel([target?.defaultModelSelection, appDefault], providers, fallback);
        projectId = await evaluatorProject(modelSelection);
      } catch (error) {
        throw refused(error, false);
      }
      try {
        await timed(launchHandoffThread({ rpc, proposal, projectId, modelSelection }), LAUNCH_MS, "T3 timed out");
      } catch (error) {
        throw t3Refused(error) ? refused(error, true) : error;
      }
    },

    commitOf: (projectPath: string) => resolveCommit(projectPath),
    snapshotPath: (proposalId: string) => snapshotPath(evaluatorDir, proposalId),
    async prepareSnapshot(proposal: HandoffProposal) {
      try {
        await ensureSnapshot({ evaluatorDir, proposalId: proposal.id, projectId: proposal.projectId, projectPath: proposal.projectPath, commit: proposal.commit });
      } catch (error) {
        throw Object.assign(error instanceof Error ? error : new Error(String(error)), { invalid: error instanceof SnapshotError && error.invalid });
      }
    },
    sweepSnapshots: (proposals: HandoffProposal[]) => sweepSnapshots({ evaluatorDir, proposals }),

    async threadExists(threadId: string) {
      try {
        return Boolean(await timed(rpc.call("orchestration.getThreadProjection", { threadId }), QUERY_MS, "T3 timed out"));
      } catch (error) {
        // Only T3 saying it has no such thread counts as "no"; any other failure leaves it unknown.
        if (t3Refused(error) && threadNotFound(error)) return false;
        throw error;
      }
    },
  };
}
