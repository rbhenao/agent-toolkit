/**
 * The content formats agent-toolkit ships and accepts, and the loader for the library bundled with the package.
 *
 * Three kinds of content, each validated when loaded:
 *
 * - A rule is Markdown with `description`, optional `paths`, and optional `references` frontmatter. Without `paths` it
 *   always applies. Every reference it lists must be cited in its body by its `.agents/references/` path, and the
 *   reverse.
 * - A skill is a directory whose `SKILL.md` frontmatter names the skill and describes it within the Agent Skills
 *   limits. Its files are shipped unchanged.
 * - A reference is a document with provenance frontmatter (title, source, pinned upstream, retrieval date, license),
 *   shipped unchanged and only when an enabled rule cites it.
 *
 * Rule and skill text is shared by every tool, so it must not name a tool's own directory. Repo-only rules and skills
 * use the same formats and go through the same validation, which is why the loaders here also serve `.agent-toolkit/`.
 * Content directories may hold only regular UTF-8 files; symlinks and other special files are rejected.
 *
 * The bundled library's version is the installed package version, which is what repos pin.
 *
 * @module
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { basename, extname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseDocument } from "yaml";

/** Bundled library root. `src/` and `dist/` both sit one level below the package root. */
export const LIBRARY_DIR = fileURLToPath(new URL("../library/", import.meta.url));

/** Installed package manifest, which carries the toolkit version. */
export const PACKAGE_FILE = fileURLToPath(new URL("../package.json", import.meta.url));

/** Kebab-case rule and skill names. */
export const NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Exact `MAJOR.MINOR.PATCH` version, as published and as pinned. */
export const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/;

/** Repo-relative prefix that rule bodies cite references by, which is also where references are written. */
export const REFERENCE_PREFIX = ".agents/references/";

/** A `REFERENCE_PREFIX` citation in a rule body; the id ends at `.md`. */
const CITATION_PATTERN = /\.agents\/references\/[\w./-]*?\.md\b/g;

/** Tool directories that shared text must not name, so one body serves every tool. */
const TOOL_DIR_PATTERN = /\.(?:claude|cursor|codex)\//;

/** Skill entry point, required in every skill directory. */
const SKILL_FILE = "SKILL.md";

/** Agent Skills limits, past which tools may ignore a skill. */
const SKILL_NAME_MAX = 64;

const SKILL_DESCRIPTION_MAX = 1024;

/**
 * Names skipped wherever they appear in a content path: OS metadata, empty-directory placeholders, and Python
 * bytecode caches, which appear beside any bundled script a test imports.
 */
export const IGNORED_NAMES: ReadonlySet<string> = new Set([".DS_Store", ".gitkeep", "__pycache__"]);

const RULE_KEYS: ReadonlySet<string> = new Set(["description", "paths", "references"]);

const REFERENCE_KEYS: ReadonlySet<string> = new Set(["title", "source", "upstream", "retrieved", "license"]);

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const FENCE = "---\n";

/** An opening `---` line, whole YAML lines, and a closing `---` line that may end the file. LF only. */
const FRONTMATTER_PATTERN = /^---\n((?:.*\n)*?)---(?:\n|$)/;

const UTF8 = new TextDecoder("utf-8", { fatal: true });

/** A rule file: `description`, `paths`, and `references` as frontmatter, then the body. */
export interface LibraryRule {
  readonly name: string;
  readonly description: string;
  /** Glob patterns that trigger the rule; empty means it always applies. */
  readonly paths: readonly string[];
  /** Reference ids the body cites, such as `ansible/good-practices-for-ansible.md`. */
  readonly references: readonly string[];
  readonly body: string;
}

/** A skill directory: a `SKILL.md` entry point plus any supporting files, shipped unchanged. */
export interface LibrarySkill {
  readonly name: string;
  /** From the `SKILL.md` frontmatter. */
  readonly description: string;
  /** Skill-relative POSIX path to file content. */
  readonly files: ReadonlyMap<string, string>;
}

/** A reference document with provenance frontmatter, shipped unchanged. */
export interface LibraryReference {
  /** Path under `library/references/`, which is also its path under `.agents/references/`. */
  readonly id: string;
  readonly content: string;
}

/** Every rule, skill, and reference in a content directory, keyed by name or id. */
export interface Library {
  readonly rules: ReadonlyMap<string, LibraryRule>;
  readonly skills: ReadonlyMap<string, LibrarySkill>;
  readonly references: ReadonlyMap<string, LibraryReference>;
}

/** A content directory: where it is on disk, and the relative name error messages use for it. */
export interface ContentDir {
  readonly path: string;
  /** Such as `.agent-toolkit/rules`, so messages name files the way the user sees them. */
  readonly label: string;
}

/** Report an invalid rule, skill, or reference file; the CLI prints the message without a stack trace. */
export class ContentError extends Error {
  override name = "ContentError";
}

/**
 * Load every rule, skill, and reference under `dir`. A missing `rules/`, `skills/`, or `references/` is empty.
 *
 * @throws {ContentError} When any file is invalid or a rule cites a reference the library does not have.
 */
export function loadLibrary(dir: string = LIBRARY_DIR): Library {
  const root: ContentDir = { path: dir, label: "library" };
  const library = {
    rules: loadRules(childDir(root, "rules")),
    skills: loadSkills(childDir(root, "skills")),
    references: loadReferences(childDir(root, "references")),
  };

  for (const rule of library.rules.values()) {
    const missing = rule.references.filter((id) => !library.references.has(id));
    if (missing.length > 0) {
      throw new ContentError(
        `library/rules/${rule.name}.md: cites references not in the library: ${missing.join(", ")}`,
      );
    }
  }

  return library;
}

/** Return the content directory `name` inside `dir`. */
export function childDir(dir: ContentDir, name: string): ContentDir {
  return { path: join(dir.path, name), label: `${dir.label}/${name}` };
}

/**
 * Parse one rule file into its frontmatter fields and body. Library and repo-only rules share this format.
 *
 * @param label - How errors name the file.
 */
export function parseRule(name: string, text: string, label = `rules/${name}.md`): LibraryRule {
  assertName(label, name);
  const { fields, body } = readFrontmatter(label, text);
  assertKnownKeys(label, fields, RULE_KEYS);

  const rule = {
    name,
    description: requireString(label, fields, "description"),
    paths: optionalPaths(label, fields, "paths"),
    references: optionalPaths(label, fields, "references"),
    body: body.trim(),
  };

  if (rule.body === "") {
    throw new ContentError(`${label}: body is empty`);
  }
  assertToolNeutral(label, rule.body);
  assertCitations(label, rule.body, rule.references);
  return rule;
}

/**
 * Validate a skill's files: a `SKILL.md` whose frontmatter names the skill and describes it within tool limits.
 *
 * @param label - How errors name the skill directory.
 */
export function parseSkill(name: string, files: ReadonlyMap<string, string>, label = `skills/${name}`): LibrarySkill {
  assertName(label, name);
  if (name.length > SKILL_NAME_MAX) {
    throw new ContentError(`${label}: name must be at most ${String(SKILL_NAME_MAX)} characters`);
  }
  const entryPoint = files.get(SKILL_FILE);
  if (entryPoint === undefined) {
    throw new ContentError(`${label}: missing ${SKILL_FILE}`);
  }

  const entryLabel = `${label}/${SKILL_FILE}`;
  const { fields } = readFrontmatter(entryLabel, entryPoint);
  if (fields.name !== name) {
    throw new ContentError(`${entryLabel}: frontmatter name must be ${name}`);
  }
  const description = requireString(entryLabel, fields, "description");
  if (description.length > SKILL_DESCRIPTION_MAX) {
    throw new ContentError(`${entryLabel}: description must be at most ${String(SKILL_DESCRIPTION_MAX)} characters`);
  }

  for (const [path, content] of files) {
    assertToolNeutral(`${label}/${path}`, content);
  }
  return { name, description, files };
}

/** Read every file under a skill directory, keyed by skill-relative POSIX path. */
export function readSkillFiles(dir: ContentDir): ReadonlyMap<string, string> {
  return new Map(listFiles(dir).map((path) => [path, readText(join(dir.path, path), `${dir.label}/${path}`)]));
}

/** Read the installed toolkit version, which is also the version of the bundled library. */
export function readToolkitVersion(file: string = PACKAGE_FILE): string {
  const manifest: unknown = JSON.parse(readFileSync(file, "utf8"));
  const version = isRecord(manifest) ? manifest.version : undefined;

  if (typeof version !== "string" || !VERSION_PATTERN.test(version)) {
    throw new Error(`${file}: version must be MAJOR.MINOR.PATCH`);
  }
  return version;
}

/** Load the `<name>.md` rules directly under `dir`; a missing `dir` has none. */
export function loadRules(dir: ContentDir): ReadonlyMap<string, LibraryRule> {
  return loadMarkdownFiles(dir, "rules", parseRule);
}

/** Load the `<name>/` skill directories under `dir`; a missing `dir` has none. */
export function loadSkills(dir: ContentDir): ReadonlyMap<string, LibrarySkill> {
  if (!hasDirectory(dir)) {
    return new Map();
  }

  const skills = new Map<string, LibrarySkill>();
  for (const entry of readdirSync(dir.path, { withFileTypes: true }).toSorted((a, b) => compareText(a.name, b.name))) {
    if (IGNORED_NAMES.has(entry.name)) {
      continue;
    }
    const skillDir = childDir(dir, entry.name);
    if (!entry.isDirectory()) {
      throw new ContentError(`${skillDir.label}: skills must be directories under skills/`);
    }
    skills.set(entry.name, parseSkill(entry.name, readSkillFiles(skillDir), skillDir.label));
  }
  return skills;
}

/** Load the `<name>.md` rule extensions directly under `dir`; a missing `dir` has none. */
export function loadExtensions(dir: ContentDir): ReadonlyMap<string, string> {
  return loadMarkdownFiles(dir, "extensions", parseExtension);
}

/**
 * Validate text appended to rule `name`: Markdown with no frontmatter that cites no tool directory or reference.
 *
 * @param label - How errors name the file.
 */
export function parseExtension(name: string, text: string, label = `extensions/${name}.md`): string {
  assertName(label, name);
  const body = text.trim();

  if (body === "") {
    throw new ContentError(`${label}: is empty`);
  }
  if (text.startsWith(FENCE)) {
    throw new ContentError(`${label}: extensions have no frontmatter; set description and paths in the config`);
  }
  assertToolNeutral(label, body);
  if (body.includes(REFERENCE_PREFIX)) {
    throw new ContentError(`${label}: extensions cannot cite references; cite them from a repo-only rule`);
  }
  return body;
}

/**
 * Report whether content directory `dir` exists.
 *
 * @throws {ContentError} When something other than a directory is at `dir`.
 */
export function hasDirectory(dir: ContentDir): boolean {
  const stats = statSync(dir.path, { throwIfNoEntry: false });
  if (stats === undefined) {
    return false;
  }
  if (!stats.isDirectory()) {
    throw new ContentError(`${dir.label}: must be a directory`);
  }
  return true;
}

/** Order strings by UTF-16 code unit, the same order `toSorted()` gives without a comparator. */
export function compareText(a: string, b: string): number {
  if (a === b) {
    return 0;
  }
  return a < b ? -1 : 1;
}

/** Report whether `value` is a non-null, non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Report whether `value` is a non-empty, trimmed, repo-relative path that does not climb out with `..`. */
export function isRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value !== "" &&
    value.trim() === value &&
    !isAbsolute(value) &&
    !value.split("/").includes("..")
  );
}

/** Parse each `<name>.md` directly under `dir`, keyed by name. */
function loadMarkdownFiles<T>(
  dir: ContentDir,
  kind: string,
  parse: (name: string, text: string, label: string) => T,
): ReadonlyMap<string, T> {
  if (!hasDirectory(dir)) {
    return new Map();
  }

  const items = new Map<string, T>();
  for (const path of listFiles(dir)) {
    const label = `${dir.label}/${path}`;
    if (path.includes("/") || extname(path) !== ".md") {
      throw new ContentError(`${label}: ${kind} must be .md files directly under ${kind}/`);
    }
    const name = basename(path, ".md");
    items.set(name, parse(name, readText(join(dir.path, path), label), label));
  }
  return items;
}

function loadReferences(dir: ContentDir): ReadonlyMap<string, LibraryReference> {
  if (!hasDirectory(dir)) {
    return new Map();
  }

  return new Map(
    listFiles(dir).map((id) => {
      const label = `${dir.label}/${id}`;
      return [id, parseReference(id, readText(join(dir.path, id), label), label)];
    }),
  );
}

/** Validate a reference's provenance frontmatter; its content is shipped unchanged. */
function parseReference(id: string, text: string, label: string): LibraryReference {
  if (extname(id) !== ".md") {
    throw new ContentError(`${label}: references must be .md files`);
  }

  const { fields } = readFrontmatter(label, text);
  assertKnownKeys(label, fields, REFERENCE_KEYS);
  for (const key of REFERENCE_KEYS) {
    requireString(label, fields, key);
  }

  if (!DATE_PATTERN.test(requireString(label, fields, "retrieved"))) {
    throw new ContentError(`${label}: retrieved must be a YYYY-MM-DD date`);
  }
  return { id, content: text };
}

/** Return the regular files under `dir` as sorted relative paths, refusing symlinks and other special files. */
function listFiles(dir: ContentDir): readonly string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir.path, { withFileTypes: true, recursive: true })) {
    const path = relative(dir.path, join(entry.parentPath, entry.name));
    if (entry.isDirectory() || path.split("/").some((segment) => IGNORED_NAMES.has(segment))) {
      continue;
    }
    if (!entry.isFile()) {
      throw new ContentError(`${dir.label}/${path}: only regular files and directories are allowed`);
    }
    files.push(path);
  }
  return files.toSorted();
}

function readText(path: string, label: string): string {
  const bytes = readFileSync(path);
  try {
    return UTF8.decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new ContentError(`${label}: not UTF-8 text`);
    }
    throw error;
  }
}

/** Split `text` into its YAML frontmatter mapping and the body after the closing fence. */
function readFrontmatter(label: string, text: string): { fields: Record<string, unknown>; body: string } {
  if (text.startsWith("---\r\n")) {
    throw new ContentError(`${label}: use LF line endings, not CRLF`);
  }
  if (!text.startsWith(FENCE)) {
    throw new ContentError(`${label}: must start with a --- frontmatter line`);
  }
  const match = FRONTMATTER_PATTERN.exec(text);
  if (match === null) {
    throw new ContentError(`${label}: frontmatter has no closing --- line`);
  }

  const document = parseDocument(match[1] ?? "");
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) {
    throw new ContentError(`${label}: invalid frontmatter: ${problem.message}`);
  }

  const fields: unknown = document.toJS();
  if (!isRecord(fields)) {
    throw new ContentError(`${label}: frontmatter must be a mapping`);
  }
  return { fields, body: text.slice(match[0].length) };
}

function assertName(label: string, name: string): void {
  if (!NAME_PATTERN.test(name)) {
    throw new ContentError(`${label}: name must be kebab-case`);
  }
}

function assertKnownKeys(label: string, fields: Record<string, unknown>, allowed: ReadonlySet<string>): void {
  const unknown = Object.keys(fields).filter((key) => !allowed.has(key));
  if (unknown.length > 0) {
    throw new ContentError(`${label}: unknown frontmatter keys: ${unknown.join(", ")}`);
  }
}

function assertToolNeutral(label: string, text: string): void {
  const match = TOOL_DIR_PATTERN.exec(text);
  if (match !== null) {
    throw new ContentError(`${label}: names tool directory ${match[0]}; cite .agents/ paths instead`);
  }
}

/** Require the body's `.agents/references/` citations to match the `references` frontmatter exactly. */
function assertCitations(label: string, body: string, references: readonly string[]): void {
  const cited = new Set(
    Array.from(body.matchAll(CITATION_PATTERN), (match) => match[0].slice(REFERENCE_PREFIX.length)),
  );
  const listed = new Set(references);

  const unlisted = [...cited].filter((id) => !listed.has(id));
  if (unlisted.length > 0) {
    throw new ContentError(`${label}: body cites references missing from frontmatter: ${unlisted.join(", ")}`);
  }
  const uncited = references.filter((id) => !cited.has(id));
  if (uncited.length > 0) {
    throw new ContentError(`${label}: frontmatter lists references the body never cites: ${uncited.join(", ")}`);
  }
}

function requireString(label: string, fields: Record<string, unknown>, key: string): string {
  const value = fields[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ContentError(`${label}: ${key} must be a non-empty string`);
  }
  return value;
}

/** Read an optional list of unique repo-relative paths; absent means empty. */
function optionalPaths(label: string, fields: Record<string, unknown>, key: string): readonly string[] {
  const value = fields[key];
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value) || !value.every(isRelativePath)) {
    throw new ContentError(`${label}: ${key} must be a list of repo-relative paths`);
  }
  if (new Set(value).size !== value.length) {
    throw new ContentError(`${label}: ${key} has duplicate entries`);
  }
  return value;
}
