// The read-only copy of a project an approved handoff thread reads: the tracked files of one commit,
// exported from git into <evaluator>/snapshots/<proposalId>, never the live working tree. A local
// .env, build output or anything else untracked or ignored stays out, and so do .git, symlinks and
// submodules. The commit is fixed when the Bot proposes, so the approved text stays true however
// the project moves on.
//   - The export lands in a temporary folder inside snapshots/ and is renamed into place only when
//     complete; then it is made read-only and a sibling <proposalId>.json records what it holds.
//   - Sizes are read from git before anything is written: a repo over the caps is refused, never
//     written out first.
//   - sweepSnapshots removes old and unneeded copies, touching only entries it could have made.
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, type Stats } from "node:fs";
import path from "node:path";

/** A tracked file larger than this is left out of the copy (and listed as skipped). */
export const SNAPSHOT_MAX_FILE_BYTES = 5 * 1024 * 1024;
/** All tracked files of the commit together; a larger project is refused. */
export const SNAPSHOT_MAX_TRACKED_BYTES = 1024 * 1024 * 1024;
/** The files kept in the copy together; a larger copy is refused. */
export const SNAPSHOT_MAX_KEPT_BYTES = 200 * 1024 * 1024;
/** Copies older than this are removed by the sweep. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 86_400_000;
/** Temporary export folders older than this were left by an export that never finished. */
export const SNAPSHOT_TEMP_MAX_AGE_MS = 3_600_000;
/** How many skipped paths the record lists. */
export const SNAPSHOT_SKIPPED_LISTED = 50;
const TEMP_PREFIX = ".export-";
const GIT_MS = 60_000;
const EXPORT_MS = 10 * 60_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Why a snapshot could not be made. `invalid`: the commit is gone, so the proposal can never be approved. */
export class SnapshotError extends Error {
  readonly invalid: boolean;
  constructor(message: string, invalid = false) { super(message); this.invalid = invalid; }
}

export const snapshotsDir = (evaluatorDir: string) => path.join(evaluatorDir, "snapshots");
export const snapshotPath = (evaluatorDir: string, proposalId: string) => path.join(snapshotsDir(evaluatorDir), proposalId);

// No hooks, pagers or fsmonitor; read-only commands that take no lock.
const GIT_FLAGS = ["-c", "core.fsmonitor=false", "-c", "core.pager=cat"];
const gitEnv = () => ({ ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" });

function git(cwd: string, args: string[], maxBuffer = 64 << 20): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", ["-C", cwd, ...GIT_FLAGS, ...args], { timeout: GIT_MS, maxBuffer, env: gitEnv() }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

/** Git ran and answered no (a non-zero exit), as opposed to missing, timed out or killed. */
const gitSaidNo = (error: unknown) => typeof (error as { code?: unknown })?.code === "number";

/**
 * The full sha of the commit checked out in the project's repo. Throws a SnapshotError when the
 * folder is not in a git repo or the repo has no commit yet.
 */
export async function resolveCommit(projectPath: string): Promise<string> {
  let out: string;
  try { out = await git(projectPath, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]); }
  catch (error) {
    if (gitSaidNo(error)) throw new SnapshotError("That project is not a git repository with a commit. A handoff reads a read-only copy of one commit, so the project needs git and at least one commit.");
    throw new SnapshotError(`Couldn't read that project's git repository: ${(error as Error).message}`);
  }
  const sha = out.trim();
  if (!COMMIT.test(sha)) throw new SnapshotError("Couldn't read that project's commit from git.");
  return sha;
}

/** What a finished copy holds, written next to it as <proposalId>.json. */
export type SnapshotRecord = { proposalId: string; projectId: string; commit: string; createdAt: string; files: number; bytes: number; skipped: string[] };

type TreeEntry = { mode: string; type: string; object: string; size: number; path: string };

/** A path from a git tree that is safe to write under the copy: plain segments, no .git. */
function safeSegments(file: string): string[] | null {
  const segments = file.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || segment.toLowerCase() === ".git" || segment.includes("\\") || segment.includes("\0"))) return null;
  return segments;
}

async function treeOf(top: string, commit: string, prefix: string): Promise<TreeEntry[]> {
  const out = await git(top, ["ls-tree", "-r", "-l", "-z", "--full-tree", `${commit}:${prefix}`], 512 << 20);
  return out.split("\0").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    const [mode, type, object, size] = line.slice(0, tab).split(/ +/);
    return { mode, type, object, size: Number(size), path: line.slice(tab + 1) };
  });
}

/** Writes each blob, in order, through `write`; one `git cat-file --batch` for all of them. */
function catBlobs(top: string, objects: string[], write: (index: number, content: Buffer) => Promise<void>): Promise<void> {
  if (objects.length === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", top, ...GIT_FLAGS, "cat-file", "--batch"], { env: gitEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let done = false;
    const finish = (error?: unknown) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) { child.kill("SIGKILL"); reject(error); } else resolve();
    };
    const timer = setTimeout(() => finish(new Error("git took too long to export the project")), EXPORT_MS);
    child.on("error", finish);
    child.on("close", (code) => { if (index < objects.length) finish(new Error(`git cat-file stopped early (${code})`)); });
    let buffer: Buffer = Buffer.alloc(0);
    let index = 0;
    let need: number | null = null;
    let writing = Promise.resolve();
    child.stdout.on("data", (chunk: Buffer) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      try {
        for (;;) {
          if (need === null) {
            const newline = buffer.indexOf(10);
            if (newline < 0) break;
            const header = buffer.subarray(0, newline).toString("utf8").split(" ");
            if (header[1] !== "blob" || header[0] !== objects[index]) throw new Error(`git cat-file answered ${header.join(" ")}`);
            need = Number(header[2]);
            buffer = buffer.subarray(newline + 1);
          }
          if (buffer.length < need + 1) break;
          const content = Buffer.from(buffer.subarray(0, need));
          buffer = buffer.subarray(need + 1);
          need = null;
          const at = index++;
          writing = writing.then(() => write(at, content));
          if (index === objects.length) {
            child.stdin.end();
            writing.then(() => finish(), finish);
            return;
          }
        }
      } catch (error) { finish(error); }
    });
    child.stdin.on("error", finish);
    child.stdin.end(objects.join("\n") + "\n");
  });
}

/** Makes an entry and everything inside it writable again, so it can be removed; never follows a symlink. */
async function makeWritable(target: string) {
  let info: Stats;
  try { info = await fs.lstat(target); } catch { return; }
  if (info.isSymbolicLink()) return;
  if (info.isDirectory()) {
    await fs.chmod(target, 0o700).catch(() => {});
    for (const name of await fs.readdir(target).catch(() => [] as string[])) await makeWritable(path.join(target, name));
  } else {
    await fs.chmod(target, 0o600).catch(() => {});
  }
}

async function removeEntry(target: string) {
  await makeWritable(target);
  await fs.rm(target, { recursive: true, force: true });
}

/** Files 0444 and folders 0555, deepest first. */
async function makeReadOnly(dir: string) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) await makeReadOnly(full);
    else if (entry.isFile()) await fs.chmod(full, 0o444);
  }
  await fs.chmod(dir, 0o555);
}

async function readRecord(file: string): Promise<SnapshotRecord | null> {
  try {
    const info = await fs.lstat(file);
    if (!info.isFile()) return null;
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    return parsed && typeof parsed === "object" ? parsed as SnapshotRecord : null;
  } catch { return null; }
}

/** snapshots/ itself, made if missing; null when it is a symlink or not a folder (then nothing is touched). */
async function ownSnapshotsDir(evaluatorDir: string, create: boolean): Promise<string | null> {
  const dir = snapshotsDir(evaluatorDir);
  try {
    const info = await fs.lstat(dir);
    return info.isDirectory() && !info.isSymbolicLink() ? dir : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return null;
    await fs.mkdir(dir, { mode: 0o700 });
    return dir;
  }
}

/**
 * Makes sure the copy of `commit` for this proposal exists and is complete, else exports it. Throws
 * a SnapshotError: `invalid` when the commit is no longer in the repo, otherwise why it was refused
 * (too large, git failed) with nothing launched.
 */
export const SNAPSHOT_LIMITS = { maxFileBytes: SNAPSHOT_MAX_FILE_BYTES, maxTrackedBytes: SNAPSHOT_MAX_TRACKED_BYTES, maxKeptBytes: SNAPSHOT_MAX_KEPT_BYTES };

export async function ensureSnapshot({ evaluatorDir, proposalId, projectId, projectPath, commit, now = () => new Date(), limits = SNAPSHOT_LIMITS }: {
  evaluatorDir: string; proposalId: string; projectId: string; projectPath: string; commit: string; now?: () => Date; limits?: typeof SNAPSHOT_LIMITS;
}): Promise<SnapshotRecord> {
  if (!UUID.test(proposalId) || !COMMIT.test(commit)) throw new SnapshotError("This proposal has no commit to copy.", true);
  const dir = await ownSnapshotsDir(evaluatorDir, true);
  if (!dir) throw new SnapshotError(`The evaluator's snapshots folder ${snapshotsDir(evaluatorDir)} is not a plain folder.`);
  const target = path.join(dir, proposalId);
  const recordFile = `${target}.json`;
  const existing = await readRecord(recordFile);
  const folder = await fs.lstat(target).catch(() => null);
  if (existing?.commit === commit && existing.proposalId === proposalId && folder?.isDirectory() && !folder.isSymbolicLink()) return existing;
  // Anything half there (a crash between rename and record) is made again.
  if (folder) await removeEntry(target);
  if (existing || (await fs.lstat(recordFile).catch(() => null))) await removeEntry(recordFile);

  try { await git(projectPath, ["cat-file", "-e", `${commit}^{commit}`]); }
  catch (error) {
    if (gitSaidNo(error)) throw new SnapshotError(`commit ${commit.slice(0, 10)} is no longer in the project's repository`, true);
    throw new SnapshotError(`Couldn't read the project's git repository: ${(error as Error).message}`);
  }
  let top: string;
  let prefix: string;
  try {
    const [topOut, prefixOut] = (await git(projectPath, ["rev-parse", "--show-toplevel", "--show-prefix"])).split("\n");
    top = topOut.trim();
    prefix = prefixOut.trim().replace(/\/$/, "");
  } catch (error) { throw new SnapshotError(`Couldn't read the project's git repository: ${(error as Error).message}`); }
  let entries: TreeEntry[];
  try { entries = await treeOf(top, commit, prefix); }
  catch (error) {
    if (gitSaidNo(error)) throw new SnapshotError(`The project's folder is not in commit ${commit.slice(0, 10)}.`);
    throw new SnapshotError(`Couldn't list the project's files in git: ${(error as Error).message}`);
  }

  const kept: { object: string; segments: string[]; size: number }[] = [];
  const skipped: string[] = [];
  let tracked = 0;
  let bytes = 0;
  for (const entry of entries) {
    const regular = entry.type === "blob" && (entry.mode === "100644" || entry.mode === "100755");
    if (entry.type === "blob" && Number.isFinite(entry.size)) tracked += entry.size;
    const segments = safeSegments(entry.path);
    // Symlinks, submodules, unsafe paths and oversized files stay out.
    if (!regular || !segments || !Number.isFinite(entry.size) || entry.size > limits.maxFileBytes) { skipped.push(entry.path); continue; }
    kept.push({ object: entry.object, segments, size: entry.size });
    bytes += entry.size;
  }
  const mb = (value: number) => `${Math.round(value / 1024 / 1024)} MB`;
  if (tracked > limits.maxTrackedBytes) throw new SnapshotError(`The project is too large to copy: its tracked files at that commit add up to ${mb(tracked)}, over the ${mb(limits.maxTrackedBytes)} limit.`);
  if (bytes > limits.maxKeptBytes) throw new SnapshotError(`The project is too large to copy: its files of up to ${mb(limits.maxFileBytes)} each add up to ${mb(bytes)}, over the ${mb(limits.maxKeptBytes)} limit.`);

  let files = kept.length;
  const temp = path.join(dir, `${TEMP_PREFIX}${proposalId}-${randomUUID()}`);
  await fs.mkdir(temp, { mode: 0o700 });
  try {
    const made = new Set<string>();
    await catBlobs(top, kept.map((file) => file.object), async (index, content) => {
      const { segments, size } = kept[index];
      const file = path.join(temp, ...segments);
      const parent = path.dirname(file);
      try {
        if (!made.has(parent)) { await fs.mkdir(parent, { recursive: true, mode: 0o700 }); made.add(parent); }
        await fs.writeFile(file, content, { flag: "wx", mode: 0o600 });
      } catch (error) {
        // Two tracked paths that are one on this disk (A.md and a.md on a case-insensitive one): the first stays.
        if (!["EEXIST", "ENOTDIR", "EISDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        skipped.push(segments.join("/"));
        files -= 1;
        bytes -= size;
      }
    });
    await makeReadOnly(temp);
    await fs.rename(temp, target);
  } catch (error) {
    await removeEntry(temp).catch(() => {});
    throw error instanceof SnapshotError ? error : new SnapshotError(`Couldn't copy the project: ${(error as Error).message}`);
  }
  const record: SnapshotRecord = { proposalId, projectId, commit, createdAt: now().toISOString(), files, bytes, skipped: skipped.slice(0, SNAPSHOT_SKIPPED_LISTED) };
  const recordTemp = path.join(dir, `${TEMP_PREFIX}${proposalId}-${randomUUID()}.json`);
  await fs.writeFile(recordTemp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(recordTemp, recordFile);
  return record;
}

/** Statuses whose copy is no longer needed. */
const DONE = new Set(["rejected", "expired", "invalid", "failed"]);

/**
 * Removes copies older than SNAPSHOT_MAX_AGE_MS or whose proposal is gone or finished without a
 * thread, and temporary export folders older than SNAPSHOT_TEMP_MAX_AGE_MS. Only entries directly
 * in snapshots/ named like ones ensureSnapshot makes are touched, and nothing if snapshots/ is a
 * symlink. Returns the names removed.
 */
export async function sweepSnapshots({ evaluatorDir, proposals, now = () => new Date() }: {
  evaluatorDir: string; proposals: { id: string; status: string }[]; now?: () => Date;
}): Promise<string[]> {
  const dir = await ownSnapshotsDir(evaluatorDir, false);
  if (!dir) return [];
  const statuses = new Map(proposals.map((proposal) => [proposal.id, proposal.status]));
  const time = now().getTime();
  const removed: string[] = [];
  const remove = async (name: string) => { await removeEntry(path.join(dir, name)); removed.push(name); };
  const names = await fs.readdir(dir);
  const ids = new Set<string>();
  for (const name of names) {
    if (name.startsWith(TEMP_PREFIX)) {
      const info = await fs.lstat(path.join(dir, name)).catch(() => null);
      if (info && time - info.mtimeMs > SNAPSHOT_TEMP_MAX_AGE_MS) await remove(name);
      continue;
    }
    const id = name.endsWith(".json") ? name.slice(0, -5) : name;
    if (UUID.test(id)) ids.add(id);
  }
  for (const id of ids) {
    const record = await readRecord(path.join(dir, `${id}.json`));
    const folder = await fs.lstat(path.join(dir, id)).catch(() => null);
    const made = Date.parse(record?.createdAt ?? "") || folder?.mtimeMs || 0;
    const status = statuses.get(id);
    if (status !== undefined && !DONE.has(status) && time - made <= SNAPSHOT_MAX_AGE_MS) continue;
    if (names.includes(id)) await remove(id);
    if (names.includes(`${id}.json`)) await remove(`${id}.json`);
  }
  return removed;
}
