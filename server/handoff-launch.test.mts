import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import { createHandoffs, type HandoffTarget } from "./handoff.mts";
import { EVALUATOR_PROJECT_TITLE, createHandoffLauncher, evaluatorProblem, t3Refused, threadNotFound, type HandoffT3Project } from "./handoff-launch.mts";

/** The evaluator settings handoffs require, and nothing more: the keys checked, as the real file holds them. */
const HARDENED = {
  disableAllHooks: true,
  sandbox: { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, filesystem: { denyRead: ["~/", "~/.ssh"], denyWrite: ["~/.threebot/evaluator"] } },
  permissions: { deny: ["Bash", "Edit", "Write", "mcp__bot__*", "mcp__t3-code__t3_thread_send"], disableBypassPermissionsMode: "disable", blockReadsOutsideWorkingDirectories: true },
};

const CLAUDE = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
/** A failure as T3Client reports one T3 answered with. */
const t3Failure = (message: string) => Object.assign(new Error(message), { cause: [{ _tag: "Fail", error: { message } }] });
// What T3 0.1.12 answers for a thread it does not have.
const t3NoThread = (threadId: string) => Object.assign(new Error("Failed to load thread"), { cause: [{ _tag: "Fail", error: {
  _tag: "OrchestrationV2GetThreadProjectionError", threadId, message: `Failed to load orchestration V2 thread ${threadId}`,
  cause: { name: "OrchestratorProjectionError", cause: { name: "ProjectionStoreThreadNotFoundError", message: `No orchestration projection exists for thread ${threadId}.` } },
} }] });

/** Removes a folder that holds read-only snapshots. */
async function forceRemove(dir: string) {
  const open = async (target: string) => {
    const info = await lstat(target).catch(() => null);
    if (!info || info.isSymbolicLink()) return;
    await chmod(target, 0o700);
    if (info.isDirectory()) for (const name of await readdir(target)) await open(path.join(target, name));
  };
  await open(dir);
  await rm(dir, { recursive: true, force: true });
}

async function setup(t: TestContext, { settings = true }: { settings?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-launch-"));
  t.after(() => forceRemove(dir));
  // The target project: a git repo with one commit.
  const app = path.join(dir, "app");
  await mkdir(app);
  await writeFile(path.join(app, "README.md"), "# App\n");
  const git = (...args: string[]) => execFileSync("git", ["-C", app, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" } });
  git("init", "-q");
  git("add", "-A");
  git("-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "first");
  const evaluatorDir = path.join(dir, "evaluator");
  await mkdir(path.join(evaluatorDir, ".claude"), { recursive: true });
  if (settings) await writeFile(path.join(evaluatorDir, ".claude", "settings.json"), JSON.stringify(HARDENED));
  const projects: HandoffT3Project[] = [
    { id: "project-app", title: "App", workspaceRoot: path.join(dir, "app"), defaultModelSelection: { instanceId: "codex", model: "gpt-6-sol" } },
    { id: "project-bot", title: "Reader", workspaceRoot: path.join(dir, "bots", "reader") },
  ];
  const calls: { tag: string; payload: any }[] = [];
  const threads = new Set<string>();
  const t3 = {
    launch: async (_payload: any): Promise<unknown> => ({}),
    threadAnswer: null as ((threadId: string) => Promise<unknown>) | null,
    /** T3 can't list its projects: a launch fails before anything is sent. */
    projectsDown: false,
  };
  const rpc = {
    async call(tag: string, payload: any) {
      calls.push({ tag, payload });
      if (tag === "projects.mutate" && payload.type === "project.create") {
        await new Promise((resolve) => setTimeout(resolve, 10));
        projects.push({ id: payload.projectId, title: payload.title, workspaceRoot: payload.workspaceRoot });
        return {};
      }
      if (tag === "orchestration.launchThread") { const answer = await t3.launch(payload); threads.add(payload.threadId); return answer; }
      if (tag === "orchestration.getThreadProjection") {
        if (t3.threadAnswer) return t3.threadAnswer(payload.threadId);
        if (!threads.has(payload.threadId)) throw t3NoThread(payload.threadId);
        return { thread: { id: payload.threadId } };
      }
      throw new Error(`unexpected ${tag}`);
    },
  };
  // Eligibility as the gateway computes it (not a Bot); the evaluator is taken out by the launcher.
  const eligible = async (): Promise<HandoffTarget[]> => projects
    .filter((project) => !project.archivedAt && project.id !== "project-bot")
    .map((project) => ({ projectId: project.id, title: project.title ?? project.id, path: project.workspaceRoot! }));
  const launcher = createHandoffLauncher({
    evaluatorDir, recordsDir: path.join(dir, "handoff-snapshots"), rpc, projects: async () => { if (t3.projectsDown) throw new Error("T3 timed out"); return projects.filter((project) => !project.deletedAt); }, eligible,
    models: async () => ({ providers: [{ instanceId: "claudeAgent", driver: "claudeAgent" }, { instanceId: "codex", driver: "codex" }], appDefault: CLAUDE, fallback: CLAUDE }),
  });
  const allowlistFile = path.join(dir, "handoff-allowlist.json");
  await writeFile(allowlistFile, JSON.stringify({ reader: { projects: ["project-app"] } }));
  const handoffs = createHandoffs({ file: path.join(dir, "handoffs.json"), allowlistFile, launcher });
  const target = (await eligible())[0];
  const propose = (url = "https://example.com/tool") => handoffs.propose({ bot: { slug: "reader", name: "Reader" }, threadId: "thread-1", project: target, kind: "evaluate-fit", url });
  return { dir, evaluatorDir, projects, calls, t3, launcher, handoffs, propose, eligible };
}

test("the evaluator folder counts only with its .claude/settings.json", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-evaluator-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.match((await evaluatorProblem(path.join(dir, "missing")))!, /evaluator folder .*missing.* or its \.claude\/settings\.json is missing/);
  assert.match((await evaluatorProblem(dir))!, /settings\.json is missing/);
  await mkdir(path.join(dir, ".claude", "settings.json"), { recursive: true });
  assert.match((await evaluatorProblem(dir))!, /settings\.json is missing/, "a folder named settings.json is not settings");
  await rm(path.join(dir, ".claude"), { recursive: true });
  await mkdir(path.join(dir, ".claude"));
  await writeFile(path.join(dir, ".claude", "settings.json"), JSON.stringify(HARDENED));
  assert.equal(await evaluatorProblem(dir), null);
});

test("evaluator settings count only when they hold every hardening rule, and the refusal names what is missing", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-evaluator-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, ".claude"));
  const write = (value: unknown) => writeFile(path.join(dir, ".claude", "settings.json"), typeof value === "string" ? value : JSON.stringify(value));
  const deny = HARDENED.permissions.deny;
  const cases: [unknown, RegExp][] = [
    ["{}", /sandbox\.enabled: true.*permissions\.disableBypassPermissionsMode/],
    ["not json", /valid JSON/],
    ["[]", /sandbox\.enabled: true/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, enabled: "true" } }, /needs sandbox\.enabled: true\.$/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, failIfUnavailable: undefined } }, /needs sandbox\.failIfUnavailable: true\.$/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, allowUnsandboxedCommands: undefined } }, /needs sandbox\.allowUnsandboxedCommands: false\.$/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, deny: deny.filter((rule) => rule !== "mcp__bot__*") } }, /needs permissions\.deny "mcp__bot__\*"\.$/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, deny: deny.filter((rule) => rule !== "mcp__t3-code__t3_thread_send") } }, /needs permissions\.deny "mcp__t3-code__t3_thread_send"\.$/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, deny: "Edit Write mcp__bot__* mcp__t3-code__t3_thread_send" } }, /permissions\.deny "Edit"/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, disableBypassPermissionsMode: undefined } }, /needs permissions\.disableBypassPermissionsMode: "disable"\.$/],
    // No shell, reads kept to its folder, no hooks, the home folder unreadable.
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, deny: deny.filter((rule) => rule !== "Bash") } }, /needs permissions\.deny "Bash"\.$/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, blockReadsOutsideWorkingDirectories: undefined } }, /needs permissions\.blockReadsOutsideWorkingDirectories: true\.$/],
    [{ ...HARDENED, disableAllHooks: false }, /needs disableAllHooks: true\.$/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, filesystem: { denyRead: ["~/.ssh"] } } }, /needs sandbox\.filesystem\.denyRead "~\/"\.$/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, filesystem: undefined } }, /needs sandbox\.filesystem\.denyRead "~\/"\.$/],
    // Nothing that widens it again.
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, allow: ["Bash(ls:*)"] } }, /needs no permissions\.allow rules\.$/],
    [{ ...HARDENED, permissions: { ...HARDENED.permissions, additionalDirectories: ["/Users/someone/Developer"] } }, /needs no permissions\.additionalDirectories\.$/],
    [{ ...HARDENED, sandbox: { ...HARDENED.sandbox, filesystem: { ...HARDENED.sandbox.filesystem, allowRead: [] } } }, /needs no sandbox\.filesystem\.allowRead\.$/],
  ];
  for (const [settings, message] of cases) {
    await write(settings);
    const problem = await evaluatorProblem(dir);
    assert.match(problem ?? "", /^Handoffs are turned off: the evaluator's \.claude\/settings\.json is not hardened/, JSON.stringify(settings));
    assert.match(problem!, message, JSON.stringify(settings));
  }
  // More rules than required are fine.
  await write({ ...HARDENED, permissions: { ...HARDENED.permissions, deny: [...deny, "Bash(curl:*)"] } });
  assert.equal(await evaluatorProblem(dir), null);
});

test("evaluator settings that are not hardened refuse both proposing and approving", async (t) => {
  const ready = await setup(t);
  const { proposal } = await ready.propose();
  await writeFile(path.join(ready.evaluatorDir, ".claude", "settings.json"), "{}");
  await assert.rejects(ready.propose("https://example.com/other"), { status: 503, message: /not hardened/ });
  await assert.rejects(ready.handoffs.approve("reader", proposal.id), { status: 503, message: /not hardened/ });
  assert.equal((await ready.handoffs.get("reader", proposal.id)).status, "pending");
});

test("a missing .claude/settings.json in the evaluator folder refuses both proposing and approving", async (t) => {
  const ready = await setup(t);
  const { proposal } = await ready.propose();
  await rm(path.join(ready.evaluatorDir, ".claude", "settings.json"));
  await assert.rejects(ready.propose("https://example.com/other"), { status: 503, message: /settings\.json is missing/ });
  await assert.rejects(ready.handoffs.approve("reader", proposal.id), { status: 503, message: /settings\.json is missing/ });
  assert.equal((await ready.handoffs.get("reader", proposal.id)).status, "pending");
  assert.deepEqual(ready.calls.filter((call) => call.tag !== "orchestration.getThreadProjection"), []);
  const never = await setup(t, { settings: false });
  await assert.rejects(never.propose(), { status: 503 });
});

test("an approved handoff runs in the evaluator's project, made once when T3 has none", async (t) => {
  const { handoffs, propose, calls, evaluatorDir, projects } = await setup(t);
  const first = (await propose("https://example.com/one")).proposal;
  const second = (await propose("https://example.org/two")).proposal;
  assert.equal(first.snapshotPath, path.join(evaluatorDir, "snapshots", first.id));
  assert.ok(first.prompt.includes(`at commit ${first.commit}: ${first.snapshotPath}\n`));
  assert.equal(first.prompt.includes(projects[0].workspaceRoot!), false);
  // Two approvals at once make one evaluator project.
  const [a, b] = await Promise.all([handoffs.approve("reader", first.id), handoffs.approve("reader", second.id)]);
  assert.equal(a.status, "launched");
  assert.equal(b.status, "launched");
  const created = calls.filter((call) => call.tag === "projects.mutate");
  assert.equal(created.length, 1);
  assert.deepEqual({ ...created[0].payload, commandId: "x", projectId: "x" }, {
    type: "project.create", commandId: "x", projectId: "x", title: EVALUATOR_PROJECT_TITLE, workspaceRoot: evaluatorDir,
    createWorkspaceRootIfMissing: false, defaultModelSelection: CLAUDE,
  });
  const launches = calls.filter((call) => call.tag === "orchestration.launchThread").map((call) => call.payload);
  assert.equal(launches.length, 2);
  for (const launch of launches) {
    assert.equal(launch.projectId, created[0].payload.projectId);
    assert.deepEqual(launch.workspaceStrategy, { type: "root" });
    assert.equal(launch.runtimeMode, "approval-required");
    assert.equal(launch.interactionMode, "plan");
    // The target defaults to Codex, so the app's Claude default runs it.
    assert.deepEqual(launch.modelSelection, CLAUDE);
  }
  assert.equal(launches.find((launch) => launch.threadId === first.launch.threadId).initialMessage.text, first.prompt);
  // Each approved thread's copy exists, with the project's tracked file.
  for (const proposal of [first, second]) assert.deepEqual(await readdir(proposal.snapshotPath), ["README.md"]);
});

test("an existing evaluator project is found by its folder, and archived ones are not used", async (t) => {
  const { handoffs, propose, calls, evaluatorDir, projects } = await setup(t);
  projects.push({ id: "project-old-evaluator", workspaceRoot: evaluatorDir, archivedAt: "2026-01-01T00:00:00Z" });
  projects.push({ id: "project-evaluator", workspaceRoot: `${evaluatorDir}/` });
  const { proposal } = await propose();
  await handoffs.approve("reader", proposal.id);
  assert.equal(calls.filter((call) => call.tag === "projects.mutate").length, 0);
  assert.equal(calls.find((call) => call.tag === "orchestration.launchThread")!.payload.projectId, "project-evaluator");
});

test("the evaluator's project is never a handoff target", async (t) => {
  const { launcher, eligible, evaluatorDir, projects } = await setup(t);
  projects.push({ id: "project-evaluator", title: EVALUATOR_PROJECT_TITLE, workspaceRoot: evaluatorDir });
  projects.push({ id: "project-inside", workspaceRoot: path.join(evaluatorDir, "nested") });
  assert.ok((await eligible()).some((target) => target.projectId === "project-evaluator"));
  assert.deepEqual((await launcher.targets()).map((target) => target.projectId), ["project-app"]);
  const proposal = { projectId: "project-evaluator", projectPath: evaluatorDir } as never;
  assert.match((await launcher.invalidTarget(proposal))!, /no longer one a handoff may target/);
});

test("approval checks the target again: gone, archived, no longer eligible or moved", async (t) => {
  const { launcher, projects } = await setup(t);
  const app = projects[0];
  const proposal = { projectId: "project-app", projectPath: app.workspaceRoot! } as never;
  assert.equal(await launcher.invalidTarget(proposal), null);
  assert.equal(await launcher.invalidTarget({ projectId: "project-app", projectPath: `${app.workspaceRoot}/` } as never), null);
  app.workspaceRoot = `${app.workspaceRoot}-moved`;
  assert.match((await launcher.invalidTarget(proposal))!, /folder changed/);
  app.archivedAt = "2026-11-26T00:00:00Z";
  assert.match((await launcher.invalidTarget(proposal))!, /archived/);
  assert.match((await launcher.invalidTarget({ projectId: "project-bot", projectPath: projects[1].workspaceRoot! } as never))!, /no longer one a handoff may target/);
  projects.splice(0, 1);
  assert.match((await launcher.invalidTarget(proposal))!, /no longer in T3/);
});

test("a target moved since the proposal is marked invalid at approval and never launched", async (t) => {
  const { handoffs, propose, projects, calls } = await setup(t);
  const { proposal } = await propose();
  projects[0].workspaceRoot = "/somewhere/else";
  await assert.rejects(handoffs.approve("reader", proposal.id), { status: 409 });
  const stored = await handoffs.get("reader", proposal.id);
  assert.equal(stored.status, "invalid");
  assert.match(stored.invalidReason!, /folder changed/);
  assert.equal(calls.filter((call) => call.tag === "orchestration.launchThread").length, 0);
});

test("T3's own failure answer is told apart from a call that may have gone through", async (t) => {
  assert.equal(t3Refused(t3Failure("Unknown project")), true);
  assert.equal(t3Refused(Object.assign(new Error("x"), { cause: { failures: [{ _tag: "Fail", error: {} }] } })), true);
  assert.equal(t3Refused(new Error("T3 timed out")), false);
  assert.equal(t3Refused(new Error("socket closed 1006")), false);
  assert.equal(t3Refused(Object.assign(new Error("interrupted"), { cause: [{ _tag: "Interrupt" }] })), false);
  assert.equal(t3Refused(Object.assign(new Error("defect"), { cause: [{ _tag: "Die", defect: "boom" }] })), false);

  const { handoffs, propose, t3, launcher } = await setup(t);
  const refused = (await propose("https://example.com/refused")).proposal;
  t3.launch = async () => { throw t3Failure("Unknown project"); };
  await assert.rejects(handoffs.approve("reader", refused.id), { status: 502 });
  assert.equal((await handoffs.get("reader", refused.id)).status, "pending");
  const dropped = (await propose("https://example.com/dropped")).proposal;
  t3.launch = async () => { throw new Error("socket closed 1006"); };
  await assert.rejects(handoffs.approve("reader", dropped.id), { status: 504 });
  t3.threadAnswer = async () => { throw new Error("socket closed"); };
  assert.equal((await handoffs.get("reader", dropped.id)).status, "launching");
  await assert.rejects(launcher.threadExists("anything"), /socket closed/);
  // A failure that is not "no such thread" (T3 could not load it) says nothing either way.
  t3.threadAnswer = async () => { throw t3Failure("database is locked"); };
  await assert.rejects(launcher.threadExists("anything"), /database is locked/);
  assert.equal((await handoffs.get("reader", dropped.id)).status, "launching");
  t3.threadAnswer = null;
  assert.equal(await launcher.threadExists("anything"), false);
  // The launcher says whether a refusal came from T3 or from never sending the launch.
  t3.launch = async () => { throw t3Failure("Unknown project"); };
  await assert.rejects(launcher.launch(dropped), { refused: true, sent: true });
  t3.projectsDown = true;
  await assert.rejects(launcher.launch(dropped), { refused: true, sent: false });
  t3.projectsDown = false;
  t3.launch = async () => { throw new Error("socket closed 1006"); };
  await assert.rejects(launcher.launch(dropped), (error: { refused?: unknown }) => error.refused === undefined);
});

test("only T3's own no-such-thread answer, by its structure, counts as a thread T3 does not have", async (t) => {
  assert.equal(threadNotFound(t3NoThread("t")), true);
  assert.equal(threadNotFound(Object.assign(new Error("x"), { cause: { failures: t3NoThread("t").cause } })), true);
  // The same words in a message, another error tag, or the name too deep or nowhere are not it.
  const mentions = Object.assign(new Error("x"), { cause: [{ _tag: "Fail", error: {
    _tag: "OrchestrationV2GetThreadProjectionError", message: "ProjectionStoreThreadNotFoundError",
    cause: { name: "SqliteError", message: "database is locked (ProjectionStoreThreadNotFoundError)", cause: { message: "ThreadNotFound" } },
  } }] });
  assert.equal(threadNotFound(mentions), false);
  const otherTag = Object.assign(new Error("x"), { cause: [{ _tag: "Fail", error: { _tag: "ProjectionStoreThreadNotFoundError", cause: { name: "ProjectionStoreThreadNotFoundError" } } }] });
  assert.equal(threadNotFound(otherTag), false);
  const notFail = Object.assign(new Error("x"), { cause: [{ ...t3NoThread("t").cause[0], _tag: "Die" }] });
  assert.equal(threadNotFound(notFail), false);
  const mixed = Object.assign(new Error("x"), { cause: [t3NoThread("t").cause[0], { _tag: "Fail", error: { message: "database is locked" } }] });
  assert.equal(threadNotFound(mixed), false);
  let deep: Record<string, unknown> = { name: "ProjectionStoreThreadNotFoundError" };
  for (let i = 0; i < 20; i++) deep = { name: "Wrapper", cause: deep };
  assert.equal(threadNotFound(Object.assign(new Error("x"), { cause: [{ _tag: "Fail", error: { _tag: "OrchestrationV2GetThreadProjectionError", cause: deep } }] })), false);
  assert.equal(threadNotFound(new Error("ThreadNotFound")), false);

  // Through the launcher: such an answer leaves the thread unknown, not missing.
  const { launcher, t3 } = await setup(t);
  t3.threadAnswer = async () => { throw mentions; };
  await assert.rejects(launcher.threadExists("anything"));
});

test("a target folder that is not a git repo with a commit gets no proposal", async (t) => {
  const { handoffs, dir } = await setup(t);
  const plain = path.join(dir, "plain");
  await mkdir(plain);
  await assert.rejects(handoffs.propose({ bot: { slug: "reader", name: "Reader" }, threadId: "thread-1", project: { projectId: "project-app", title: "App", path: plain }, kind: "evaluate-fit", url: "https://example.com/tool" }),
    { status: 400, message: /not a git repository with a commit/ });
  assert.deepEqual(await handoffs.list("reader"), []);
  assert.deepEqual(await readdir(dir).then((names) => names.includes("evaluator") ? readdir(path.join(dir, "evaluator")) : []), [".claude"]);
});
