/**
 * A repo's choices: what it asks for in `agent-toolkit.yaml`, what it adds under `.agent-toolkit/`, and how the two
 * combine with the bundled library.
 *
 * The config holds structure only: an exact toolkit version pin, the tools to generate for, the library rules to
 * enable with optional `description` or `paths` settings, and the library skills to enable. All rule and skill text
 * lives in files. Repo-only content is found by location rather than listed: `rules/<name>.md` and `skills/<name>/`
 * add items, and `extensions/<name>.md` appends text to the enabled library rule of the same name.
 *
 * Resolution is strict so mistakes surface early: an unknown library name, a repo item that reuses a library name, an
 * extension with nothing to extend, and a citation of a reference the library lacks are all errors. The result
 * carries exactly the references its rules cite.
 *
 * The pin is compared numerically with the installed version, and is rewritten in place so the rest of the config
 * file keeps its formatting and comments.
 *
 * @module
 */

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type Document, isScalar, parseDocument } from "yaml";

import {
  childDir,
  compareText,
  type ContentDir,
  hasDirectory,
  IGNORED_NAMES,
  isRecord,
  isRelativePath,
  type Library,
  type LibraryReference,
  type LibraryRule,
  type LibrarySkill,
  loadExtensions,
  loadRules,
  loadSkills,
  VERSION_PATTERN,
} from "./library.js";

/** Repo config file, read from the repo root. */
export const CONFIG_FILE = "agent-toolkit.yaml";

/** Directory holding repo-only rules and skills and extensions to library rules, each found by file name. */
export const LOCAL_DIR = ".agent-toolkit";

/** Tools the toolkit can generate files for. */
export const TARGET_NAMES = ["claude", "cursor", "codex"] as const;

/** One tool the toolkit generates files for. */
export type Target = (typeof TARGET_NAMES)[number];

/** Settings for one enabled library rule. Each field replaces the library rule's value. */
export interface RuleEntry {
  readonly description?: string;
  readonly paths?: readonly string[];
}

/** The repo's `agent-toolkit.yaml`. It holds structure only; all rule and skill text lives in files. */
export interface Config {
  /** Exact `MAJOR.MINOR.PATCH` toolkit version the generated files are built from. */
  readonly toolkit: string;
  readonly targets: readonly Target[];
  /** Library rules to enable, by name. */
  readonly rules: ReadonlyMap<string, RuleEntry>;
  /** Library skills to enable, by name. */
  readonly skills: readonly string[];
}

/** Repo-specific sources under `.agent-toolkit/`. Every file found there is included. */
export interface LocalSources {
  /** From `rules/<name>.md`, in library rule format. Names must not collide with the library. */
  readonly rules: ReadonlyMap<string, LibraryRule>;
  /** From `skills/<name>/`. Names must not collide with the library. */
  readonly skills: ReadonlyMap<string, LibrarySkill>;
  /** From `extensions/<name>.md`, appended to the body of the enabled library rule `<name>`. */
  readonly extensions: ReadonlyMap<string, string>;
}

/** A rule as the repo gets it, with config settings and any extension applied. */
export interface ResolvedRule {
  readonly name: string;
  readonly description: string;
  /** Glob patterns that trigger the rule; empty means it always applies. */
  readonly paths: readonly string[];
  readonly body: string;
}

/** A skill as the repo gets it. */
export interface ResolvedSkill {
  readonly name: string;
  /** Skill-relative POSIX path to file content. */
  readonly files: ReadonlyMap<string, string>;
}

/** Everything a repo gets: enabled library items with settings and extensions applied, plus repo-only items. */
export interface ResolvedConfig {
  readonly targets: readonly Target[];
  readonly rules: readonly ResolvedRule[];
  readonly skills: readonly ResolvedSkill[];
  /** References cited by the resolved rules. */
  readonly references: readonly LibraryReference[];
}

/** How a repo's pinned version relates to the installed one: `behind` needs `upgrade`, `ahead` a newer toolkit. */
export type PinStatus = "match" | "behind" | "ahead";

/** Report an invalid repo config or local source; the CLI prints the message without a stack trace. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

const CONFIG_KEYS: ReadonlySet<string> = new Set(["toolkit", "targets", "rules", "skills"]);

const RULE_ENTRY_KEYS: ReadonlySet<string> = new Set(["description", "paths"]);

/** The only entries `.agent-toolkit/` may hold, besides ignored files. */
const LOCAL_ENTRIES: ReadonlySet<string> = new Set(["rules", "skills", "extensions"]);

/**
 * Orders validated `MAJOR.MINOR.PATCH` versions. Numeric collation compares each run of digits as a number and the
 * dots as equal, so `1.10.0` sorts after `1.9.0`.
 */
const VERSION_ORDER = new Intl.Collator("en", { numeric: true });

/** Parse and validate the text of `agent-toolkit.yaml`. Absent or empty `rules` and `skills` enable nothing. */
export function parseConfig(text: string): Config {
  const fields: unknown = parseYaml(text).toJS();
  if (!isRecord(fields)) {
    throw new ConfigError(`${CONFIG_FILE}: must be a mapping`);
  }
  const unknown = Object.keys(fields).filter((key) => !CONFIG_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${CONFIG_FILE}: unknown keys: ${unknown.join(", ")}`);
  }

  return {
    toolkit: parsePin(fields.toolkit),
    targets: parseTargets(fields.targets),
    rules: parseRuleEntries(fields.rules),
    skills: parseSkillNames(fields.skills),
  };
}

/** Read and parse `agent-toolkit.yaml` from `root`. */
export function readConfig(root: string): Config {
  return parseConfig(readConfigText(root));
}

/** Read the text of `agent-toolkit.yaml` from `root`. */
export function readConfigText(root: string): string {
  try {
    return readFileSync(join(root, CONFIG_FILE), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      throw new ConfigError(`no ${CONFIG_FILE} in ${root}; run agent-toolkit init`);
    }
    throw error;
  }
}

/** Create `agent-toolkit.yaml` under `root` with `text`, refusing to replace an existing one. */
export function createConfig(root: string, text: string): void {
  try {
    writeFileSync(join(root, CONFIG_FILE), text, { flag: "wx" });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ConfigError(`${CONFIG_FILE} already exists; edit it, then run agent-toolkit sync`);
    }
    throw error;
  }
}

/** Replace the text of `agent-toolkit.yaml` under `root`. */
export function writeConfigText(root: string, text: string): void {
  writeFileSync(join(root, CONFIG_FILE), text);
}

/** Read the repo-only rules, skills, and extensions under `root`'s `.agent-toolkit/`; empty when it is absent. */
export function readLocal(root: string): LocalSources {
  const dir: ContentDir = { path: join(root, LOCAL_DIR), label: LOCAL_DIR };
  if (hasDirectory(dir)) {
    const unexpected = readdirSync(dir.path).filter((name) => !LOCAL_ENTRIES.has(name) && !IGNORED_NAMES.has(name));
    if (unexpected.length > 0) {
      throw new ConfigError(
        `${LOCAL_DIR}: unexpected entries ${unexpected.join(", ")}; expected rules, skills, or extensions`,
      );
    }
  }

  return {
    rules: loadRules(childDir(dir, "rules")),
    skills: loadSkills(childDir(dir, "skills")),
    extensions: loadExtensions(childDir(dir, "extensions")),
  };
}

/**
 * Combine `config`, `library`, and `local` into what the repo gets, with rules and skills sorted by name.
 *
 * @throws {ConfigError} When the config names an unknown library item, a local item shares a library name, an
 *   extension has no enabled library rule, or a local rule cites a reference the library does not have.
 */
export function resolveConfig(config: Config, library: Library, local: LocalSources): ResolvedConfig {
  assertNoCollisions("rule", local.rules, library.rules);
  assertNoCollisions("skill", local.skills, library.skills);
  for (const name of local.extensions.keys()) {
    if (!config.rules.has(name)) {
      throw new ConfigError(`${LOCAL_DIR}/extensions/${name}.md: no enabled library rule ${name} to extend`);
    }
  }

  const rules = [
    ...[...config.rules].map(([name, entry]) =>
      applyRuleEntry(requireLibraryItem("rule", name, library.rules), entry, local.extensions.get(name)),
    ),
    ...local.rules.values(),
  ].toSorted((a, b) => compareText(a.name, b.name));
  const skills = [
    ...config.skills.map((name) => requireLibraryItem("skill", name, library.skills)),
    ...local.skills.values(),
  ].toSorted((a, b) => compareText(a.name, b.name));

  return {
    targets: config.targets,
    rules: rules.map(({ name, description, paths, body }) => ({ name, description, paths, body })),
    skills,
    references: collectReferences(rules, library.references),
  };
}

/** Compare the pinned version with the installed one. */
export function comparePin(pinned: string, installed: string): PinStatus {
  for (const version of [pinned, installed]) {
    if (!VERSION_PATTERN.test(version)) {
      throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
    }
  }

  const order = VERSION_ORDER.compare(pinned, installed);
  if (order === 0) {
    return "match";
  }
  return order < 0 ? "behind" : "ahead";
}

/** Return config `text` with the `toolkit` value, quotes included, replaced by `version`; nothing else changes. */
export function setPin(text: string, version: string): string {
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`not a MAJOR.MINOR.PATCH version: ${version}`);
  }

  const node = parseYaml(text).get("toolkit", true);
  if (!isScalar(node) || !node.range) {
    throw new ConfigError(`${CONFIG_FILE}: toolkit must be set before it can be changed`);
  }
  const [start, end] = node.range;
  return `${text.slice(0, start)}${version}${text.slice(end)}`;
}

/** Return the starter config `init` writes: pinned to `version`, with the toolkit's own rule and skill enabled. */
export function starterConfig(version: string): string {
  return [
    "# Rebuild generated files with `agent-toolkit sync`; `agent-toolkit list` shows the library.",
    `# Repo-only content goes in ${LOCAL_DIR}/: rules/<name>.md, skills/<name>/, extensions/<name>.md.`,
    `toolkit: ${version}`,
    "targets:",
    ...TARGET_NAMES.map((target) => `  - ${target}`),
    "# Library rules to enable, each optionally with `description` or `paths` settings.",
    "# agent-toolkit keeps agents from editing generated files.",
    "rules:",
    "  agent-toolkit:",
    "# Library skills to enable. agent-toolkit-authoring lets agents add and change the content above.",
    "skills:",
    "  - agent-toolkit-authoring",
    "",
  ].join("\n");
}

function parseYaml(text: string): Document {
  const document = parseDocument(text);
  const problem = document.errors[0] ?? document.warnings[0];
  if (problem !== undefined) {
    throw new ConfigError(`${CONFIG_FILE}: invalid YAML: ${problem.message}`);
  }
  return document;
}

function parsePin(value: unknown): string {
  if (typeof value !== "string" || !VERSION_PATTERN.test(value)) {
    throw new ConfigError(`${CONFIG_FILE}: toolkit must be an exact MAJOR.MINOR.PATCH version`);
  }
  return value;
}

function parseTargets(value: unknown): readonly Target[] {
  if (!Array.isArray(value) || value.length === 0 || !value.every(isTarget)) {
    throw new ConfigError(`${CONFIG_FILE}: targets must be a non-empty list of ${TARGET_NAMES.join(", ")}`);
  }
  if (new Set(value).size !== value.length) {
    throw new ConfigError(`${CONFIG_FILE}: targets has duplicate entries`);
  }
  return value;
}

function parseRuleEntries(value: unknown): ReadonlyMap<string, RuleEntry> {
  if (value === undefined || value === null) {
    return new Map();
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${CONFIG_FILE}: rules must be a mapping of library rule names`);
  }

  return new Map(Object.entries(value).map(([name, entry]) => [name, parseRuleEntry(name, entry)]));
}

/** Parse one rule's settings; a bare `name:` enables the rule unchanged. */
function parseRuleEntry(name: string, value: unknown): RuleEntry {
  const label = `${CONFIG_FILE}: rules.${name}`;
  if (value === null) {
    return {};
  }
  if (!isRecord(value)) {
    throw new ConfigError(`${label} must be empty or a mapping of description and paths`);
  }
  const unknown = Object.keys(value).filter((key) => !RULE_ENTRY_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConfigError(`${label}: unknown keys: ${unknown.join(", ")}`);
  }

  const { description, paths } = value;
  if (description !== undefined && (typeof description !== "string" || description.trim() === "")) {
    throw new ConfigError(`${label}.description must be a non-empty string`);
  }
  if (paths !== undefined && (!Array.isArray(paths) || !paths.every(isRelativePath))) {
    throw new ConfigError(`${label}.paths must be a list of repo-relative paths`);
  }
  if (paths !== undefined && new Set(paths).size !== paths.length) {
    throw new ConfigError(`${label}.paths has duplicate entries`);
  }

  return {
    ...(description === undefined ? {} : { description }),
    ...(paths === undefined ? {} : { paths }),
  };
}

function parseSkillNames(value: unknown): readonly string[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value) || !value.every((name) => typeof name === "string")) {
    throw new ConfigError(`${CONFIG_FILE}: skills must be a list of library skill names`);
  }
  if (new Set(value).size !== value.length) {
    throw new ConfigError(`${CONFIG_FILE}: skills has duplicate entries`);
  }
  return value;
}

function isTarget(value: unknown): value is Target {
  return TARGET_NAMES.some((target) => target === value);
}

function assertNoCollisions(
  kind: string,
  local: ReadonlyMap<string, unknown>,
  library: ReadonlyMap<string, unknown>,
): void {
  const shared = [...local.keys()].filter((name) => library.has(name));
  if (shared.length > 0) {
    throw new ConfigError(
      `${LOCAL_DIR}/${kind}s: ${shared.join(", ")} shares a library ${kind} name; rename to diverge from the library`,
    );
  }
}

function requireLibraryItem<T>(kind: string, name: string, items: ReadonlyMap<string, T>): T {
  const item = items.get(name);
  if (item === undefined) {
    throw new ConfigError(`${CONFIG_FILE}: ${name} is not a library ${kind}; repo-only ${kind}s go in ${LOCAL_DIR}/`);
  }
  return item;
}

function applyRuleEntry(rule: LibraryRule, entry: RuleEntry, extension: string | undefined): LibraryRule {
  return {
    ...rule,
    description: entry.description ?? rule.description,
    paths: entry.paths ?? rule.paths,
    body: extension === undefined ? rule.body : `${rule.body}\n\n${extension}`,
  };
}

/** Return the library references `rules` cite, once each, sorted by id. */
function collectReferences(
  rules: readonly LibraryRule[],
  references: ReadonlyMap<string, LibraryReference>,
): readonly LibraryReference[] {
  const cited = new Map<string, LibraryReference>();
  for (const rule of rules) {
    for (const id of rule.references) {
      const reference = references.get(id);
      if (reference === undefined) {
        throw new ConfigError(`${LOCAL_DIR}/rules/${rule.name}.md: cites reference ${id}, not in the library`);
      }
      cited.set(id, reference);
    }
  }

  return [...cited.values()].toSorted((a, b) => compareText(a.id, b.id));
}
