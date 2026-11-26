// The read-only copy of a project an approved handoff thread reads: the tracked files of one commit,
// exported from git into <evaluator>/snapshots/<name>, never the live working tree. A local
// .env, build output or anything else untracked or ignored stays out, and so do .git, symlinks and
// submodules. The commit is fixed when the Bot proposes, so the approved text stays true however
// the project moves on.
//   - Copies are kept apart from each other by not being findable: snapshots/ is execute-only for
//     its owner (SNAPSHOTS_MODE, 0311), so a known name can be opened but the folder can't be listed.
//     Each copy's name is a capability: 32 random bytes, made with the proposal and unrelated to its
//     id, held only in the proposal's snapshotPath and the prompt of that proposal's own thread. The
//     proposing Bot is told the proposal id, never the name, so it can't point another proposal's
//     evaluator at this copy. That relies on the evaluator having no shell and no write tools (evaluatorSettingsGaps requires
//     Bash, Edit and Write denied), so it can't chmod the folder back, and on nothing readable from
//     inside the evaluator folder naming other proposals. The mode is set when the folder is made
//     and asserted again on every export and sweep; nothing here ever makes it listable.
//   - What each copy holds is recorded outside the evaluator folder, in the gateway's records folder
//     (<appDir>/handoff-snapshots/<proposalId>.json), which holds the copy's name. The record is
//     written, as "exporting" with the temporary folder's name, before anything is made in
//     snapshots/, and completed afterwards.
//   - The export lands in that temporary folder inside snapshots/ (named from fresh random bytes, not
//     from the proposal) and is renamed into place only when complete; then it is made read-only.
//   - The layout before this one named copies after their proposal ids in a listable snapshots/.
//     ensureSnapshotLayout moves that whole folder out of the evaluator folder and deletes it once,
//     before the first export or sweep, and marks the records folder (LAYOUT_FILE) when done.
//   - Sizes are read from git before anything is written: a repo over the caps is refused, never
//     written out first.
//   - sweepSnapshots works from the records, since it can't list snapshots/: it removes old and
//     unneeded copies and stale exports by name, touching only entries it could have made.
import { execFile, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
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
/** A copy's folder name, and the random part of a temporary export folder's: 32 random bytes as hex. */
const NAME = /^[0-9a-f]{64}$/;
export const COMMIT = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;

/** Why a snapshot could not be made. `invalid`: the commit is gone, so the proposal can never be approved. */
export class SnapshotError extends Error {
  readonly invalid: boolean;
  constructor(message: string, invalid = false) { super(message); this.invalid = invalid; }
}

/** snapshots/: its owner may open and make entries by name, nobody may list it. */
export const SNAPSHOTS_MODE = 0o311;

export const snapshotsDir = (evaluatorDir: string) => path.join(evaluatorDir, "snapshots");
/** A new copy's folder name: unguessable, and unrelated to the proposal's id. */
export const newSnapshotName = () => randomBytes(32).toString("hex");
export const snapshotPath = (evaluatorDir: string, name: string) => path.join(snapshotsDir(evaluatorDir), name);
/** The copy's folder name at the end of a stored snapshotPath, or null when it is not one this layout makes. */
export function snapshotNameOf(stored: unknown): string | null {
  if (typeof stored !== "string") return null;
  const name = path.basename(stored);
  return NAME.test(name) ? name : null;
}
/** Why a proposal whose snapshotPath this layout did not make can't be approved. */
export const SNAPSHOT_EARLIER_VERSION = "it was made by an earlier version of Threebot; propose it again";
/** Where a copy's record is kept: the gateway's records folder, never the evaluator folder. */
export const snapshotRecordPath = (recordsDir: string, proposalId: string) => path.join(recordsDir, `${proposalId}.json`);

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

/**
 * A copy's record in the records folder, named after its proposal. "exporting": written before
 * anything is made in snapshots/, naming the copy (`name`) and the temporary folder (`temp`);
 * "complete": what the finished copy holds.
 */
export type SnapshotRecord = {
  proposalId: string; projectId: string; commit: string; createdAt: string;
  state: "exporting" | "complete";
  /** The copy's folder name in snapshots/. */
  name: string;
  temp?: string;
  files?: number; bytes?: number; skipped?: string[];
};

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
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as SnapshotRecord : null;
  } catch { return null; }
}

/** A temporary export folder's name, as ensureSnapshot makes them. */
const isTempName = (name: unknown): name is string =>
  typeof name === "string" && name.startsWith(TEMP_PREFIX) && NAME.test(name.slice(TEMP_PREFIX.length));
const isCopyName = (name: unknown): name is string => typeof name === "string" && NAME.test(name);

/**
 * snapshots/ itself, made if missing, with SNAPSHOTS_MODE asserted (an older listable folder is fixed
 * here); null when it is a symlink or not a folder (then nothing is touched).
 */
async function ownSnapshotsDir(evaluatorDir: string, create: boolean): Promise<string | null> {
  const dir = snapshotsDir(evaluatorDir);
  try {
    const info = await fs.lstat(dir);
    if (!info.isDirectory() || info.isSymbolicLink()) return null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || !create) return null;
    // Two first exports at once both get here; the one that loses the race finds the folder made.
    try { await fs.mkdir(dir, { mode: SNAPSHOTS_MODE }); }
    catch (raced) {
      if ((raced as NodeJS.ErrnoException).code !== "EEXIST") throw raced;
      return ownSnapshotsDir(evaluatorDir, false);
    }
  }
  // Asserted every time, never loosened: mkdir's mode is filtered by the umask, and a folder from
  // before this layout was listable.
  await fs.chmod(dir, SNAPSHOTS_MODE);
  return dir;
}

/** The records folder, made if missing and kept private; throws when it is not a plain folder. */
async function ownRecordsDir(recordsDir: string): Promise<void> {
  await fs.mkdir(recordsDir, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(recordsDir);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new SnapshotError(`The handoff snapshot records folder ${recordsDir} is not a plain folder.`);
  await fs.chmod(recordsDir, 0o700);
}

async function writeRecord(recordsDir: string, record: SnapshotRecord) {
  const temp = path.join(recordsDir, `.${record.proposalId}-${randomUUID()}.tmp`);
  await fs.writeFile(temp, JSON.stringify(record, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, snapshotRecordPath(recordsDir, record.proposalId));
}

async function removeRecord(recordsDir: string, proposalId: string): Promise<boolean> {
  const file = snapshotRecordPath(recordsDir, proposalId);
  if (!(await fs.lstat(file).catch(() => null))) return false;
  await fs.rm(file, { force: true });
  return true;
}

// ---------- the layout ----------

/** The layout this module makes; written to LAYOUT_FILE in the records folder once the old one is gone. */
export const SNAPSHOT_LAYOUT = "2";
export const LAYOUT_FILE = ".layout";
/** What an interrupted migration may have left, by where it was set aside. */
const OLD_PREFIX = "handoff-snapshots-old-";
const OLD_IN_EVALUATOR_PREFIX = ".snapshots-old-";

/** Migrations in flight, by folders: concurrent callers wait for the one running. */
const migrations = new Map<string, Promise<void>>();

/**
 * Makes sure snapshots/ is in this layout before anything exports into it or sweeps it. The first
 * time (no LAYOUT_FILE holding SNAPSHOT_LAYOUT in the records folder) everything from the earlier
 * layout goes: its copies were named after proposal ids, which proposing Bots are told, so none of
 * it may stay. The old snapshots/ leaves the evaluator folder in one rename (it is never listable
 * from inside meanwhile), a fresh execute-only one is made, the old tree is deleted, every earlier
 * record is dropped, and the marker is written last. An old snapshots/ that is a symlink is unlinked,
 * and what it points at is left alone. Does nothing while the evaluator folder does not exist.
 */
export function ensureSnapshotLayout(evaluatorDir: string, recordsDir: string): Promise<void> {
  const key = `${path.resolve(evaluatorDir)}\0${path.resolve(recordsDir)}`;
  let running = migrations.get(key);
  if (!running) {
    running = migrateLayout(evaluatorDir, recordsDir).finally(() => migrations.delete(key));
    migrations.set(key, running);
  }
  return running;
}

async function migrateLayout(evaluatorDir: string, recordsDir: string) {
  if (!(await fs.stat(evaluatorDir).catch(() => null))?.isDirectory()) return;
  await ownRecordsDir(recordsDir);
  const marker = path.join(recordsDir, LAYOUT_FILE);
  if ((await fs.readFile(marker, "utf8").catch(() => "")).trim() === SNAPSHOT_LAYOUT) return;
  const parent = path.dirname(recordsDir);
  // What an earlier migration set aside and did not get to delete.
  for (const name of await fs.readdir(parent)) if (name.startsWith(OLD_PREFIX)) await removeEntry(path.join(parent, name));
  for (const name of await fs.readdir(evaluatorDir)) if (name.startsWith(OLD_IN_EVALUATOR_PREFIX)) await removeEntry(path.join(evaluatorDir, name));
  const old = snapshotsDir(evaluatorDir);
  const info = await fs.lstat(old).catch(() => null);
  if (info?.isSymbolicLink()) await fs.unlink(old);
  else if (info) {
    // Unlistable from here on, still renameable.
    if (info.isDirectory()) await fs.chmod(old, 0o300).catch(() => {});
    let moved = path.join(parent, `${OLD_PREFIX}${Date.now()}-${randomBytes(4).toString("hex")}`);
    try { await fs.rename(old, moved); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      // The records folder is on another disk: set it aside in the evaluator folder, under a name
      // nobody knows, until it is deleted just below.
      moved = path.join(evaluatorDir, `${OLD_IN_EVALUATOR_PREFIX}${newSnapshotName()}`);
      await fs.rename(old, moved);
    }
    await removeEntry(moved);
  }
  for (const name of await fs.readdir(recordsDir)) if (name !== LAYOUT_FILE) await removeEntry(path.join(recordsDir, name));
  if (!(await ownSnapshotsDir(evaluatorDir, true))) throw new SnapshotError(`The evaluator's snapshots folder ${old} is not a plain folder.`);
  const temp = path.join(recordsDir, `.layout-${randomUUID()}.tmp`);
  await fs.writeFile(temp, `${SNAPSHOT_LAYOUT}\n`, { mode: 0o600 });
  await fs.rename(temp, marker);
}

// ---------- copies ----------

/**
 * Makes sure the copy of `commit` for this proposal exists, complete, in snapshots/<name>, else
 * exports it there. Throws a SnapshotError: `invalid` when the commit is no longer in the repo or
 * `name` is not one this layout makes, otherwise why it was refused (too large, git failed) with
 * nothing launched. No message names the copy's folder.
 */
export const SNAPSHOT_LIMITS = { maxFileBytes: SNAPSHOT_MAX_FILE_BYTES, maxTrackedBytes: SNAPSHOT_MAX_TRACKED_BYTES, maxKeptBytes: SNAPSHOT_MAX_KEPT_BYTES };

export async function ensureSnapshot({ evaluatorDir, recordsDir, proposalId, name, projectId, projectPath, commit, now = () => new Date(), limits = SNAPSHOT_LIMITS }: {
  evaluatorDir: string; recordsDir: string; proposalId: string; name: string; projectId: string; projectPath: string; commit: string; now?: () => Date; limits?: typeof SNAPSHOT_LIMITS;
}): Promise<SnapshotRecord> {
  if (!UUID.test(proposalId) || !COMMIT.test(commit)) throw new SnapshotError("This proposal has no commit to copy.", true);
  if (!isCopyName(name)) throw new SnapshotError(SNAPSHOT_EARLIER_VERSION, true);
  await ensureSnapshotLayout(evaluatorDir, recordsDir);
  const dir = await ownSnapshotsDir(evaluatorDir, true);
  if (!dir) throw new SnapshotError(`The evaluator's snapshots folder ${snapshotsDir(evaluatorDir)} is not a plain folder.`);
  await ownRecordsDir(recordsDir);
  const target = path.join(dir, name);
  const existing = await readRecord(snapshotRecordPath(recordsDir, proposalId));
  const folder = await fs.lstat(target).catch(() => null);
  if (existing?.state === "complete" && existing.commit === commit && existing.proposalId === proposalId && existing.name === name && folder?.isDirectory() && !folder.isSymbolicLink()) return existing;
  // Anything half there (a crash before the record was completed) is made again.
  if (folder) await removeEntry(target);
  if (isCopyName(existing?.name) && existing.name !== name) await removeEntry(path.join(dir, existing.name));
  if (isTempName(existing?.temp)) await removeEntry(path.join(dir, existing.temp));
  await removeRecord(recordsDir, proposalId);

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
  // Fresh random bytes, not the proposal's id or the copy's name: knowing either gives no way in.
  const tempName = `${TEMP_PREFIX}${newSnapshotName()}`;
  const createdAt = now().toISOString();
  // Recorded before anything is made in snapshots/: the sweep can't list that folder, so this record
  // is how it finds a temporary folder an export left behind.
  await writeRecord(recordsDir, { proposalId, projectId, commit, createdAt, state: "exporting", name, temp: tempName });
  const temp = path.join(dir, tempName);
  try {
    await fs.mkdir(temp, { mode: 0o700 });
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
    await removeRecord(recordsDir, proposalId).catch(() => {});
    if (error instanceof SnapshotError) throw error;
    // A file system error names the paths it failed on; the card shows the reason, not the names.
    const reason = String((error as Error)?.message ?? error).split(tempName).join("<export>").split(name).join("<copy>");
    throw new SnapshotError(`Couldn't copy the project: ${reason}`);
  }
  const record: SnapshotRecord = { proposalId, projectId, commit, createdAt, state: "complete", name, files, bytes, skipped: skipped.slice(0, SNAPSHOT_SKIPPED_LISTED) };
  await writeRecord(recordsDir, record);
  return record;
}

/** Statuses whose copy is no longer needed. */
const DONE = new Set(["rejected", "expired", "invalid", "failed"]);

/**
 * Removes copies older than SNAPSHOT_MAX_AGE_MS or whose proposal is gone or finished without a
 * thread, and exports still "exporting" after SNAPSHOT_TEMP_MAX_AGE_MS. snapshots/ is never listed:
 * the copies to look at come from the records folder, and every entry is opened by the name its
 * record holds. Nothing is touched if snapshots/ is a symlink, and its mode is asserted again.
 * Returns the ids of the proposals whose copy or record was removed (never a copy's name).
 */
export async function sweepSnapshots({ evaluatorDir, recordsDir, proposals, now = () => new Date() }: {
  evaluatorDir: string; recordsDir: string; proposals: { id: string; status: string }[]; now?: () => Date;
}): Promise<string[]> {
  // A layout that can't be made ready (a records folder that is not a plain folder) is left alone.
  if (!(await ensureSnapshotLayout(evaluatorDir, recordsDir).then(() => true, () => false))) return [];
  const dir = await ownSnapshotsDir(evaluatorDir, false);
  if (!dir) return [];
  if (!(await ownRecordsDir(recordsDir).then(() => true, () => false))) return [];
  const statuses = new Map(proposals.map((proposal) => [proposal.id, proposal.status]));
  const time = now().getTime();
  const removed: string[] = [];
  const remove = async (name: string) => {
    const full = path.join(dir, name);
    if (!(await fs.lstat(full).catch(() => null))) return false;
    await removeEntry(full);
    return true;
  };
  for (const file of await fs.readdir(recordsDir)) {
    const id = file.endsWith(".json") ? file.slice(0, -5) : "";
    if (!UUID.test(id)) continue;
    const record = await readRecord(snapshotRecordPath(recordsDir, id));
    if (!record) continue;
    const folder = isCopyName(record.name) ? await fs.lstat(path.join(dir, record.name)).catch(() => null) : null;
    const made = Date.parse(record.createdAt ?? "") || folder?.mtimeMs || 0;
    if (record.state === "exporting") {
      if (time - made <= SNAPSHOT_TEMP_MAX_AGE_MS) continue;
    } else {
      const status = statuses.get(id);
      if (status !== undefined && !DONE.has(status) && time - made <= SNAPSHOT_MAX_AGE_MS) continue;
    }
    let gone = false;
    if (folder && isCopyName(record.name)) gone = await remove(record.name) || gone;
    if (isTempName(record.temp)) gone = await remove(record.temp) || gone;
    if (await removeRecord(recordsDir, id)) gone = true;
    if (gone) removed.push(id);
  }
  return removed;
}
