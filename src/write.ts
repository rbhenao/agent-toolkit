/**
 * Compares a rendered plan with the repo on disk and applies it, changing only paths the toolkit owns.
 *
 * Ownership is recorded in a committed lock file listing every path the toolkit wrote, the lock included. Against that
 * record, each planned path is current, stale (owned but different, such as a hand edit), missing, or a conflict
 * (something the toolkit does not own, a directory, or anything below a symlinked parent). Owned paths the plan no
 * longer contains are orphans.
 *
 * Applying is all or nothing with respect to conflicts: any conflict means nothing is written. Otherwise orphans are
 * removed along with the directories they leave empty, only stale and missing entries are rewritten, and the lock is
 * written last. A file that already matches the plan counts as current even when unowned, so an interrupted sync
 * finishes on the next run instead of refusing its own output.
 *
 * Writes are confined to the toolkit's output directories: plans and locks that name any other path are rejected
 * before disk is touched, and nothing is written through a symlinked directory.
 *
 * @module
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, posix } from "node:path";

import { isRecord, isRelativePath } from "./library.js";
import { AGENTS_DIR, type Plan, type PlannedEntry, TARGETS } from "./render.js";

/** JSON record of the paths the toolkit owns, itself included. Only owned paths are ever changed or removed. */
export const LOCK_FILE = ".agents/toolkit.lock";

/** Directories the toolkit writes into. A plan or lock with a path anywhere else is rejected. */
export const OUTPUT_DIRS: readonly string[] = [
  AGENTS_DIR,
  ...Object.values(TARGETS).flatMap((layout) => [
    ...(layout.rules === undefined ? [] : [layout.rules.dir]),
    ...(layout.skills === undefined ? [] : [layout.skills]),
  ]),
];

/** The paths the toolkit owns, as recorded in `LOCK_FILE`. */
export interface Lock {
  readonly paths: readonly string[];
}

/** How the repo differs from a plan. Every list holds repo-relative POSIX paths. */
export interface Drift {
  /** Owned paths whose content or link target differs from the plan, including hand edits. */
  readonly stale: readonly string[];
  readonly missing: readonly string[];
  /** Owned files and links the plan no longer contains. */
  readonly orphaned: readonly string[];
  /** Planned paths held by something the toolkit does not own, a directory, or a symlinked parent directory. */
  readonly conflicts: readonly string[];
}

/** Report planned paths held by files the toolkit does not own; the CLI prints the message without a stack trace. */
export class ConflictError extends Error {
  override name = "ConflictError";
}

/** Report an unreadable `LOCK_FILE`; the CLI prints the message without a stack trace. */
export class LockError extends Error {
  override name = "LockError";
}

/** What is on disk at one path. `other` is anything the toolkit never replaces. */
type DiskEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "file"; readonly content: Buffer }
  | { readonly kind: "link"; readonly target: string }
  | { readonly kind: "other" };

type EntryState = "current" | "stale" | "missing" | "conflict";

/**
 * Read the lock under `root`, or `undefined` when the repo has never been synced.
 *
 * @throws {LockError} When the lock is not JSON or claims a path outside the toolkit's output directories.
 */
export function readLock(root: string): Lock | undefined {
  const text = readOptionalText(join(root, LOCK_FILE));
  return text === undefined ? undefined : parseLock(text);
}

/**
 * Compare `plan`, plus the lock it implies, with what is on disk under `root`.
 *
 * A file whose content already matches the plan is current even when unowned, so an interrupted sync can resume.
 */
export function diffPlan(root: string, plan: Plan, lock: Lock | undefined): Drift {
  assertSafePlan(plan);
  const entries = withLock(plan);
  const owned = new Set(lock?.paths ?? []);
  const planned = new Set(entries.map((entry) => entry.path));

  const states = entries.map((entry) => ({
    path: entry.path,
    state: classify(entry, inspectPath(root, entry.path), owned.has(entry.path)),
  }));
  const pathsIn = (state: EntryState): readonly string[] =>
    states.filter((item) => item.state === state).map((item) => item.path);

  return {
    stale: pathsIn("stale"),
    missing: pathsIn("missing"),
    orphaned: [...owned].filter((path) => !planned.has(path) && isReplaceable(inspectPath(root, path))).toSorted(),
    conflicts: pathsIn("conflict"),
  };
}

/**
 * Remove orphans and the directories they leave empty, write stale and missing entries, and record the lock last.
 *
 * @returns The drift that was applied.
 * @throws {ConflictError} When `diffPlan` reports conflicts; nothing is written.
 */
export function applyPlan(root: string, plan: Plan, lock: Lock | undefined): Drift {
  const drift = diffPlan(root, plan, lock);
  if (drift.conflicts.length > 0) {
    throw new ConflictError(
      `refusing to overwrite paths agent-toolkit does not own: ${drift.conflicts.join(", ")}; ` +
        "move or delete them, then sync again",
    );
  }

  for (const path of drift.orphaned) {
    unlinkSync(join(root, path));
    removeEmptyParents(root, path);
  }

  const changed = new Set([...drift.stale, ...drift.missing]);
  for (const entry of withLock(plan).filter((item) => changed.has(item.path))) {
    writeEntry(root, entry);
  }
  return drift;
}

/** Append the lock entry, which lists every planned path and itself, after the plan's own entries. */
function withLock(plan: Plan): Plan {
  const paths = [...plan.map((entry) => entry.path), LOCK_FILE].toSorted();
  return [...plan, { kind: "file", path: LOCK_FILE, content: `${JSON.stringify({ paths }, null, 2)}\n` }];
}

/** Reject a plan that writes outside the output directories, over the lock, or twice to one path: a toolkit bug. */
function assertSafePlan(plan: Plan): void {
  const paths = plan.map((entry) => entry.path);
  const unsafe = paths.filter((path) => !isOutputPath(path) || path === LOCK_FILE);
  if (unsafe.length > 0) {
    throw new Error(`plan has paths agent-toolkit may not write: ${unsafe.join(", ")}`);
  }
  if (new Set(paths).size !== paths.length) {
    throw new Error("plan has duplicate paths");
  }
}

function parseLock(text: string): Lock {
  const data = parseJson(text);
  const keys = isRecord(data) ? Object.keys(data) : [];
  const paths = isRecord(data) ? data.paths : undefined;

  if (keys.length !== 1 || !Array.isArray(paths) || !paths.every(isOutputPath)) {
    throw new LockError(`${LOCK_FILE}: must be {"paths": [...]} listing paths under ${OUTPUT_DIRS.join(", ")}`);
  }
  if (new Set(paths).size !== paths.length) {
    throw new LockError(`${LOCK_FILE}: paths has duplicate entries`);
  }
  return { paths };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new LockError(`${LOCK_FILE}: invalid JSON: ${error.message}`);
    }
    throw error;
  }
}

/** Report whether `value` is a normalized relative path inside one of the toolkit's output directories. */
function isOutputPath(value: unknown): value is string {
  return (
    isRelativePath(value) && posix.normalize(value) === value && OUTPUT_DIRS.some((dir) => value.startsWith(`${dir}/`))
  );
}

function classify(entry: PlannedEntry, disk: DiskEntry, owned: boolean): EntryState {
  if (disk.kind === "absent") {
    return "missing";
  }
  if (matches(entry, disk)) {
    return "current";
  }
  return disk.kind === "other" || !owned ? "conflict" : "stale";
}

function matches(entry: PlannedEntry, disk: DiskEntry): boolean {
  if (entry.kind === "file") {
    return disk.kind === "file" && disk.content.equals(Buffer.from(entry.content));
  }
  return disk.kind === "link" && disk.target === entry.target;
}

function isReplaceable(disk: DiskEntry): boolean {
  return disk.kind === "file" || disk.kind === "link";
}

/** Describe what is at `path`. Anything below a symlinked or non-directory parent is `other` and never touched. */
function inspectPath(root: string, path: string): DiskEntry {
  if (hasUnsafeParent(root, path)) {
    return { kind: "other" };
  }

  const fullPath = join(root, path);
  const stats = lstatSync(fullPath, { throwIfNoEntry: false });
  if (stats === undefined) {
    return { kind: "absent" };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "link", target: readlinkSync(fullPath) };
  }
  if (stats.isFile()) {
    return { kind: "file", content: readFileSync(fullPath) };
  }
  return { kind: "other" };
}

/** Report whether an existing parent of `path` is a symlink or non-directory, so writes could leave `root`. */
function hasUnsafeParent(root: string, path: string): boolean {
  const parents = path.split("/").slice(0, -1);
  return parents.some((_, index) => {
    const stats = lstatSync(join(root, ...parents.slice(0, index + 1)), { throwIfNoEntry: false });
    return stats !== undefined && !stats.isDirectory();
  });
}

function writeEntry(root: string, entry: PlannedEntry): void {
  const path = join(root, entry.path);
  mkdirSync(dirname(path), { recursive: true });
  rmSync(path, { force: true });

  if (entry.kind === "file") {
    writeFileSync(path, entry.content);
  } else {
    symlinkSync(entry.target, path);
  }
}

function removeEmptyParents(root: string, path: string): void {
  for (let dir = posix.dirname(path); dir !== "."; dir = posix.dirname(dir)) {
    const fullPath = join(root, dir);
    if (readdirSync(fullPath).length > 0) {
      return;
    }
    rmdirSync(fullPath);
  }
}

function readOptionalText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}
