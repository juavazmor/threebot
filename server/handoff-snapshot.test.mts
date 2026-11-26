import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  SNAPSHOT_LIMITS, SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_KEPT_BYTES, SNAPSHOT_MAX_TRACKED_BYTES, SnapshotError, ensureSnapshot, resolveCommit, snapshotPath, snapshotRecordPath, sweepSnapshots,
} from "./handoff-snapshot.mts";

const ID = "0f5c2a9e-6f0b-4a53-9a43-1d2b3c4d5e6f";
const OTHER = "1a2b3c4d-0000-4000-8000-aabbccddeeff";
const env = { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };
const git = (cwd: string, ...args: string[]) => execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8", env }).trim();
const commitAll = (cwd: string, message: string) => { git(cwd, "add", "-A"); git(cwd, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", message); return git(cwd, "rev-parse", "HEAD"); };

/** Removes a folder the tests made read-only. */
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

async function setup(t: TestContext) {
  const dir = await mkdtemp(path.join(tmpdir(), "handoff-snapshot-"));
  t.after(() => forceRemove(dir));
  const project = path.join(dir, "app");
  const evaluatorDir = path.join(dir, "evaluator");
  await mkdir(path.join(project, "src"), { recursive: true });
  const recordsDir = path.join(dir, "botapp", "handoff-snapshots");
  await mkdir(evaluatorDir);
  await writeFile(path.join(project, "README.md"), "# App\n");
  await writeFile(path.join(project, "src", "index.js"), "console.log('app');\n");
  await writeFile(path.join(project, ".gitignore"), ".env\nbuild/\n");
  git(project, "init", "-q");
  return { dir, project, evaluatorDir, recordsDir };
}

/** snapshots/ as its owner could list it only by loosening its mode, which only a test does. */
async function listAsOwner(dir: string): Promise<string[]> {
  await chmod(dir, 0o700);
  try { return (await readdir(dir)).sort(); } finally { await chmod(dir, 0o311); }
}
const modeOf = async (target: string) => (await stat(target)).mode & 0o777;

test("a proposal's commit comes from git, and a folder without git or without a commit is refused", async (t) => {
  const { dir, project } = await setup(t);
  await assert.rejects(resolveCommit(project), (error) => error instanceof SnapshotError && /not a git repository with a commit/.test(error.message));
  const plain = path.join(dir, "plain");
  await mkdir(plain);
  await assert.rejects(resolveCommit(plain), /not a git repository with a commit/);
  const sha = commitAll(project, "first");
  assert.equal(await resolveCommit(project), sha);
  assert.match(sha, /^[0-9a-f]{40}$/);
  // A project folder inside a repo uses that repo's commit.
  assert.equal(await resolveCommit(path.join(project, "src")), sha);
});

test("a snapshot holds the tracked files of the stored commit only, read-only, with its record kept by the gateway", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  await mkdir(path.join(project, "vendor"));
  await writeFile(path.join(project, "vendor", "big.bin"), Buffer.alloc(SNAPSHOT_MAX_FILE_BYTES + 1));
  await symlink("/etc/hosts", path.join(project, "hosts-link"));
  await writeFile(path.join(project, "run.sh"), "#!/bin/sh\necho hi\n", { mode: 0o755 });
  const commit = commitAll(project, "first");
  // Untracked, ignored, and committed after the proposal: none of it is in the copy.
  await writeFile(path.join(project, ".env"), "SECRET=1\n");
  await writeFile(path.join(project, "notes.txt"), "untracked\n");
  await writeFile(path.join(project, "README.md"), "# App, edited\n");
  await writeFile(path.join(project, "later.md"), "later\n");
  commitAll(project, "second");

  const record = await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, now: () => new Date("2026-11-26T10:00:00Z") });
  const copy = snapshotPath(evaluatorDir, ID);
  assert.equal(copy, path.join(evaluatorDir, "snapshots", ID));
  const listing = execFileSync("find", [copy], { encoding: "utf8" }).trim().split("\n").map((line) => path.relative(copy, line)).sort();
  assert.deepEqual(listing, ["", ".gitignore", "README.md", "run.sh", "src", "src/index.js"]);
  assert.equal(await readFile(path.join(copy, "README.md"), "utf8"), "# App\n");
  assert.equal((await stat(path.join(copy, "README.md"))).mode & 0o777, 0o444);
  assert.equal((await stat(path.join(copy, "run.sh"))).mode & 0o777, 0o444);
  assert.equal((await stat(path.join(copy, "src"))).mode & 0o777, 0o555);
  assert.equal((await stat(copy)).mode & 0o777, 0o555);
  await assert.rejects(writeFile(path.join(copy, "README.md"), "changed"), { code: "EACCES" });
  // The record is kept in the gateway's folder, not next to the copy.
  const stored = JSON.parse(await readFile(snapshotRecordPath(recordsDir, ID), "utf8"));
  assert.equal(snapshotRecordPath(recordsDir, ID), path.join(recordsDir, `${ID}.json`));
  assert.deepEqual(stored, record);
  assert.equal(await modeOf(recordsDir), 0o700);
  assert.equal(await modeOf(snapshotRecordPath(recordsDir, ID)), 0o600);
  assert.deepEqual(await readdir(recordsDir), [`${ID}.json`]);
  assert.deepEqual({ ...stored, skipped: [...(stored.skipped ?? [])].sort() }, {
    proposalId: ID, projectId: "project-app", commit, createdAt: "2026-11-26T10:00:00.000Z", state: "complete", files: 4,
    bytes: Buffer.byteLength("# App\n") + Buffer.byteLength("console.log('app');\n") + Buffer.byteLength(".env\nbuild/\n") + Buffer.byteLength("#!/bin/sh\necho hi\n"),
    skipped: ["hosts-link", "vendor/big.bin"],
  });
  // snapshots/ can't be listed, and nothing temporary or naming other proposals is left in it.
  const snapshots = path.join(evaluatorDir, "snapshots");
  assert.equal(await modeOf(snapshots), 0o311);
  await assert.rejects(readdir(snapshots), { code: "EACCES" });
  assert.deepEqual(await listAsOwner(snapshots), [ID]);
  // A complete copy is kept as it is on the next approval.
  const again = await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, now: () => new Date("2026-11-27T10:00:00Z") });
  assert.equal(again.createdAt, "2026-11-26T10:00:00.000Z");
});

test("a project in a subfolder of its repo is copied from that subfolder only", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: path.join(project, "src"), commit });
  assert.deepEqual(await readdir(snapshotPath(evaluatorDir, ID)), ["index.js"]);
});

test("a copy left half made is made again", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  const copy = snapshotPath(evaluatorDir, ID);
  await mkdir(copy, { recursive: true });
  await writeFile(path.join(copy, "stray.txt"), "from a crash");
  await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit });
  assert.deepEqual((await readdir(copy)).sort(), [".gitignore", "README.md", "src"]);
});

test("a commit no longer in the repo makes the snapshot impossible for good", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  commitAll(project, "first");
  const gone = "0123456789abcdef0123456789abcdef01234567";
  await assert.rejects(ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit: gone }),
    (error) => error instanceof SnapshotError && error.invalid && /no longer in the project's repository/.test(error.message));
  await assert.rejects(ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit: "" }), (error) => error instanceof SnapshotError && error.invalid);
});

test("a project over the size limits is refused before anything is written", async (t) => {
  assert.equal(SNAPSHOT_MAX_FILE_BYTES, 5 * 1024 * 1024);
  assert.equal(SNAPSHOT_MAX_TRACKED_BYTES, 1024 * 1024 * 1024);
  assert.equal(SNAPSHOT_MAX_KEPT_BYTES, 200 * 1024 * 1024);
  const { project, evaluatorDir, recordsDir } = await setup(t);
  await writeFile(path.join(project, "big.bin"), Buffer.alloc(4000));
  const commit = commitAll(project, "first");
  const snapshots = path.join(evaluatorDir, "snapshots");
  const make = (limits: typeof SNAPSHOT_LIMITS) => ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, limits });
  await assert.rejects(make({ ...SNAPSHOT_LIMITS, maxTrackedBytes: 3000 }), (error) => error instanceof SnapshotError && !error.invalid && /tracked files at that commit add up to/.test(error.message));
  assert.deepEqual(await listAsOwner(snapshots), []);
  assert.deepEqual(await readdir(recordsDir), []);
  await assert.rejects(make({ ...SNAPSHOT_LIMITS, maxKeptBytes: 3000 }), /too large to copy/);
  assert.deepEqual(await listAsOwner(snapshots), []);
  assert.deepEqual(await readdir(recordsDir), []);
  // The large file skipped, the rest fits.
  await make({ ...SNAPSHOT_LIMITS, maxFileBytes: 3000, maxKeptBytes: 3000 });
  assert.equal((await readdir(snapshotPath(evaluatorDir, ID))).includes("big.bin"), false);
});

test("the sweep removes old, orphaned and finished copies and stale exports by name, without listing snapshots/", async (t) => {
  const { dir, project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  const day = 86_400_000;
  const base = Date.parse("2026-11-26T10:00:00Z");
  const ids = {
    fresh: "00000000-0000-4000-8000-000000000001", old: "00000000-0000-4000-8000-000000000002", orphan: "00000000-0000-4000-8000-000000000003",
    rejected: "00000000-0000-4000-8000-000000000004", failed: "00000000-0000-4000-8000-000000000005", launched: "00000000-0000-4000-8000-000000000006",
    stale: "00000000-0000-4000-8000-000000000007", running: "00000000-0000-4000-8000-000000000008",
  };
  for (const name of ["fresh", "old", "orphan", "rejected", "failed", "launched"] as const) {
    await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ids[name], projectId: "project-app", projectPath: project, commit, now: () => new Date(name === "old" ? base - 8 * day : base - day) });
  }
  const snapshots = path.join(evaluatorDir, "snapshots");
  // Exports that recorded themselves and never finished: one two hours ago, one still running.
  const temps = { stale: `.export-${ids.stale}-${randomUUID()}`, running: `.export-${ids.running}-${randomUUID()}` };
  for (const [name, age] of [["stale", 2 * 3_600_000], ["running", 60_000]] as const) {
    await mkdir(path.join(snapshots, temps[name]));
    await writeFile(snapshotRecordPath(recordsDir, ids[name]), JSON.stringify({ proposalId: ids[name], projectId: "project-app", commit, createdAt: new Date(base - age).toISOString(), state: "exporting", temp: temps[name] }));
  }
  await writeFile(path.join(snapshots, "keep-me.txt"), "not ours");
  // A link named like a copy is removed as a link; what it points at is left alone.
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "precious.txt"), "keep");
  await symlink(outside, path.join(snapshots, OTHER));
  const proposals = [
    { id: ids.fresh, status: "pending" }, { id: ids.old, status: "launching" }, { id: ids.rejected, status: "rejected" },
    { id: ids.failed, status: "failed" }, { id: ids.launched, status: "launched" }, { id: ids.stale, status: "pending" },
    { id: ids.running, status: "pending" }, { id: OTHER, status: "rejected" },
  ];
  // Listing snapshots/ would fail: it is execute-only throughout.
  assert.equal(await modeOf(snapshots), 0o311);
  await sweepSnapshots({ evaluatorDir, recordsDir, proposals, now: () => new Date(base) });
  assert.equal(await modeOf(snapshots), 0o311);
  await assert.rejects(readdir(snapshots), { code: "EACCES" });
  assert.deepEqual(await listAsOwner(snapshots), [temps.running, ids.fresh, ids.launched, "keep-me.txt"].sort());
  assert.deepEqual((await readdir(recordsDir)).sort(), [ids.fresh, ids.launched, ids.running].map((id) => `${id}.json`).sort());
  assert.equal(await readFile(path.join(outside, "precious.txt"), "utf8"), "keep");
  // A launched one goes once it is a week old, and the running export once it is an hour old.
  await sweepSnapshots({ evaluatorDir, recordsDir, proposals, now: () => new Date(base + 7 * day) });
  assert.deepEqual(await listAsOwner(snapshots), ["keep-me.txt"]);
  assert.deepEqual(await readdir(recordsDir), []);
  assert.equal(await modeOf(snapshots), 0o311);
});

test("a listable snapshots folder from the previous layout is made execute-only, and its records move out of the evaluator folder", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  const snapshots = path.join(evaluatorDir, "snapshots");
  await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, now: () => new Date("2026-11-26T10:00:00Z") });
  // The previous layout: a listable folder holding each record next to its copy, and one whose copy is gone.
  const record = JSON.parse(await readFile(snapshotRecordPath(recordsDir, ID), "utf8"));
  const { state: _state, ...legacy } = record;
  await rm(recordsDir, { recursive: true });
  await chmod(snapshots, 0o700);
  await writeFile(path.join(snapshots, `${ID}.json`), JSON.stringify(legacy));
  await writeFile(path.join(snapshots, `${OTHER}.json`), JSON.stringify({ ...legacy, proposalId: OTHER }));
  await sweepSnapshots({ evaluatorDir, recordsDir, proposals: [{ id: ID, status: "launched" }, { id: OTHER, status: "launched" }], now: () => new Date("2026-11-26T11:00:00Z") });
  assert.equal(await modeOf(snapshots), 0o311);
  await assert.rejects(readdir(snapshots), { code: "EACCES" });
  // A known path still opens.
  assert.equal(await readFile(path.join(snapshotPath(evaluatorDir, ID), "README.md"), "utf8"), "# App\n");
  assert.deepEqual(await listAsOwner(snapshots), [ID]);
  assert.deepEqual(JSON.parse(await readFile(snapshotRecordPath(recordsDir, ID), "utf8")), record);
  assert.deepEqual(await readdir(recordsDir), [`${ID}.json`]);
  // The moved record keeps the copy as it is on the next approval.
  assert.equal((await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit })).createdAt, "2026-11-26T10:00:00.000Z");
});

test("an export makes the snapshots folder execute-only even when it was listable", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  const snapshots = path.join(evaluatorDir, "snapshots");
  await mkdir(snapshots, { mode: 0o755 });
  await chmod(snapshots, 0o755);
  await ensureSnapshot({ evaluatorDir, recordsDir, proposalId: ID, projectId: "project-app", projectPath: project, commit });
  assert.equal(await modeOf(snapshots), 0o311);
  await assert.rejects(readdir(snapshots), { code: "EACCES" });
  assert.deepEqual(await readdir(snapshotPath(evaluatorDir, ID)), [".gitignore", "README.md", "src"]);
  // Nothing inside the evaluator folder names a proposal but the copy itself.
  assert.deepEqual(await readdir(evaluatorDir), ["snapshots"]);
});

test("the sweep does nothing when the snapshots folder is a symlink", async (t) => {
  const { dir, evaluatorDir } = await setup(t);
  const elsewhere = path.join(dir, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(path.join(elsewhere, ID));
  await writeFile(path.join(elsewhere, `${ID}.json`), "{}");
  await symlink(elsewhere, path.join(evaluatorDir, "snapshots"));
  assert.deepEqual(await sweepSnapshots({ evaluatorDir, recordsDir: path.join(dir, "records"), proposals: [{ id: ID, status: "rejected" }] }), []);
  assert.deepEqual((await readdir(elsewhere)).sort(), [ID, `${ID}.json`].sort());
  await assert.rejects(ensureSnapshot({ evaluatorDir, recordsDir: path.join(dir, "records"), proposalId: ID, projectId: "p", projectPath: dir, commit: "0123456789abcdef0123456789abcdef01234567" }), /not a plain folder/);
});

test("several first copies at once all get made, though only one of them makes the snapshots folder", async (t) => {
  const { project, evaluatorDir, recordsDir } = await setup(t);
  const commit = commitAll(project, "first");
  const ids = Array.from({ length: 6 }, (_, index) => `${index}0000000-0000-4000-8000-000000000000`);
  const records = await Promise.all(ids.map((proposalId) => ensureSnapshot({ evaluatorDir, recordsDir, proposalId, projectId: "project-app", projectPath: project, commit })));
  assert.deepEqual(records.map((record) => record.proposalId), ids);
  for (const id of ids) assert.equal(await readFile(path.join(snapshotPath(evaluatorDir, id), "README.md"), "utf8"), "# App\n");
});
