import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test, type TestContext } from "node:test";
import {
  SNAPSHOT_LIMITS, SNAPSHOT_MAX_FILE_BYTES, SNAPSHOT_MAX_KEPT_BYTES, SNAPSHOT_MAX_TRACKED_BYTES, SnapshotError, ensureSnapshot, resolveCommit, snapshotPath, sweepSnapshots,
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
  await mkdir(evaluatorDir);
  await writeFile(path.join(project, "README.md"), "# App\n");
  await writeFile(path.join(project, "src", "index.js"), "console.log('app');\n");
  await writeFile(path.join(project, ".gitignore"), ".env\nbuild/\n");
  git(project, "init", "-q");
  return { dir, project, evaluatorDir };
}

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

test("a snapshot holds the tracked files of the stored commit only, read-only, with a record next to it", async (t) => {
  const { project, evaluatorDir } = await setup(t);
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

  const record = await ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, now: () => new Date("2026-11-26T10:00:00Z") });
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
  const stored = JSON.parse(await readFile(`${copy}.json`, "utf8"));
  assert.deepEqual(stored, record);
  assert.deepEqual({ ...stored, skipped: [...stored.skipped].sort() }, {
    proposalId: ID, projectId: "project-app", commit, createdAt: "2026-11-26T10:00:00.000Z", files: 4,
    bytes: Buffer.byteLength("# App\n") + Buffer.byteLength("console.log('app');\n") + Buffer.byteLength(".env\nbuild/\n") + Buffer.byteLength("#!/bin/sh\necho hi\n"),
    skipped: ["hosts-link", "vendor/big.bin"],
  });
  // Nothing temporary is left beside it.
  assert.deepEqual((await readdir(path.join(evaluatorDir, "snapshots"))).sort(), [ID, `${ID}.json`].sort());
  // A complete copy is kept as it is on the next approval.
  const again = await ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, now: () => new Date("2026-11-27T10:00:00Z") });
  assert.equal(again.createdAt, "2026-11-26T10:00:00.000Z");
});

test("a project in a subfolder of its repo is copied from that subfolder only", async (t) => {
  const { project, evaluatorDir } = await setup(t);
  const commit = commitAll(project, "first");
  await ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: path.join(project, "src"), commit });
  assert.deepEqual(await readdir(snapshotPath(evaluatorDir, ID)), ["index.js"]);
});

test("a copy left half made is made again", async (t) => {
  const { project, evaluatorDir } = await setup(t);
  const commit = commitAll(project, "first");
  const copy = snapshotPath(evaluatorDir, ID);
  await mkdir(copy, { recursive: true });
  await writeFile(path.join(copy, "stray.txt"), "from a crash");
  await ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit });
  assert.deepEqual((await readdir(copy)).sort(), [".gitignore", "README.md", "src"]);
});

test("a commit no longer in the repo makes the snapshot impossible for good", async (t) => {
  const { project, evaluatorDir } = await setup(t);
  commitAll(project, "first");
  const gone = "0123456789abcdef0123456789abcdef01234567";
  await assert.rejects(ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit: gone }),
    (error) => error instanceof SnapshotError && error.invalid && /no longer in the project's repository/.test(error.message));
  await assert.rejects(ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit: "" }), (error) => error instanceof SnapshotError && error.invalid);
});

test("a project over the size limits is refused before anything is written", async (t) => {
  assert.equal(SNAPSHOT_MAX_FILE_BYTES, 5 * 1024 * 1024);
  assert.equal(SNAPSHOT_MAX_TRACKED_BYTES, 1024 * 1024 * 1024);
  assert.equal(SNAPSHOT_MAX_KEPT_BYTES, 200 * 1024 * 1024);
  const { project, evaluatorDir } = await setup(t);
  await writeFile(path.join(project, "big.bin"), Buffer.alloc(4000));
  const commit = commitAll(project, "first");
  const snapshots = path.join(evaluatorDir, "snapshots");
  const make = (limits: typeof SNAPSHOT_LIMITS) => ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "project-app", projectPath: project, commit, limits });
  await assert.rejects(make({ ...SNAPSHOT_LIMITS, maxTrackedBytes: 3000 }), (error) => error instanceof SnapshotError && !error.invalid && /tracked files at that commit add up to/.test(error.message));
  assert.deepEqual(await readdir(snapshots), []);
  await assert.rejects(make({ ...SNAPSHOT_LIMITS, maxKeptBytes: 3000 }), /too large to copy/);
  assert.deepEqual(await readdir(snapshots), []);
  // The large file skipped, the rest fits.
  await make({ ...SNAPSHOT_LIMITS, maxFileBytes: 3000, maxKeptBytes: 3000 });
  assert.equal((await readdir(snapshotPath(evaluatorDir, ID))).includes("big.bin"), false);
});

test("the sweep removes old, orphaned and finished copies and stale exports, and touches nothing else", async (t) => {
  const { dir, project, evaluatorDir } = await setup(t);
  const commit = commitAll(project, "first");
  const day = 86_400_000;
  const base = Date.parse("2026-11-26T10:00:00Z");
  const ids = {
    fresh: "00000000-0000-4000-8000-000000000001", old: "00000000-0000-4000-8000-000000000002", orphan: "00000000-0000-4000-8000-000000000003",
    rejected: "00000000-0000-4000-8000-000000000004", failed: "00000000-0000-4000-8000-000000000005", launched: "00000000-0000-4000-8000-000000000006",
  };
  for (const [name, id] of Object.entries(ids)) {
    await ensureSnapshot({ evaluatorDir, proposalId: id, projectId: "project-app", projectPath: project, commit, now: () => new Date(name === "old" ? base - 8 * day : base - day) });
  }
  const snapshots = path.join(evaluatorDir, "snapshots");
  await mkdir(path.join(snapshots, ".export-stale"));
  await utimes(path.join(snapshots, ".export-stale"), new Date(base - 2 * 3_600_000), new Date(base - 2 * 3_600_000));
  await mkdir(path.join(snapshots, ".export-running"));
  await utimes(path.join(snapshots, ".export-running"), new Date(base - 60_000), new Date(base - 60_000));
  await writeFile(path.join(snapshots, "keep-me.txt"), "not ours");
  // A link named like a copy is removed as a link; what it points at is left alone.
  const outside = path.join(dir, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "precious.txt"), "keep");
  await symlink(outside, path.join(snapshots, OTHER));
  const proposals = [
    { id: ids.fresh, status: "pending" }, { id: ids.old, status: "launching" }, { id: ids.rejected, status: "rejected" },
    { id: ids.failed, status: "failed" }, { id: ids.launched, status: "launched" },
  ];
  await sweepSnapshots({ evaluatorDir, proposals, now: () => new Date(base) });
  const left = (await readdir(snapshots)).sort();
  assert.deepEqual(left, [".export-running", ids.fresh, `${ids.fresh}.json`, ids.launched, `${ids.launched}.json`, "keep-me.txt"].sort());
  assert.equal(await readFile(path.join(outside, "precious.txt"), "utf8"), "keep");
  // A launched one goes once it is a week old.
  await sweepSnapshots({ evaluatorDir, proposals, now: () => new Date(base + 7 * day) });
  assert.equal((await readdir(snapshots)).includes(ids.launched), false);
});

test("the sweep does nothing when the snapshots folder is a symlink", async (t) => {
  const { dir, evaluatorDir } = await setup(t);
  const elsewhere = path.join(dir, "elsewhere");
  await mkdir(elsewhere);
  await mkdir(path.join(elsewhere, ID));
  await writeFile(path.join(elsewhere, `${ID}.json`), "{}");
  await symlink(elsewhere, path.join(evaluatorDir, "snapshots"));
  assert.deepEqual(await sweepSnapshots({ evaluatorDir, proposals: [] }), []);
  assert.deepEqual((await readdir(elsewhere)).sort(), [ID, `${ID}.json`].sort());
  await assert.rejects(ensureSnapshot({ evaluatorDir, proposalId: ID, projectId: "p", projectPath: dir, commit: "0123456789abcdef0123456789abcdef01234567" }), /not a plain folder/);
});
