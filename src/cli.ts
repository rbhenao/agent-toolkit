#!/usr/bin/env node

/**
 * Command-line entry point: parses arguments, runs one command, and turns its outcome into output and an exit code.
 *
 * Every command that touches generated files follows the same pipeline: read the repo config, refuse unless its
 * pinned version matches the installed toolkit, resolve the config against the bundled library and the repo's own
 * sources, render the desired files, then either compare them with disk (`check`) or apply them (`sync`, `init`,
 * `upgrade`). `upgrade` is the one command that changes the pin, and it does so only after its sync succeeds.
 *
 * This is the only module that writes to stdout or stderr. Errors the user can fix (invalid config or content,
 * conflicting files, an unreadable lock) become a one-line message; anything else is a toolkit bug and keeps its
 * stack trace. Exit codes: 0 for success, 1 for drift found by `check`, 2 for every error.
 *
 * Commands receive their environment (repo root, output streams, installed version, library location) as a context,
 * so tests run them against temporary repos and fixture libraries.
 *
 * @module
 */

import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";

import {
  comparePin,
  type Config,
  CONFIG_FILE,
  ConfigError,
  createConfig,
  parseConfig,
  type PinStatus,
  readConfig,
  readConfigText,
  readLocal,
  resolveConfig,
  setPin,
  starterConfig,
  writeConfigText,
} from "./config.js";
import {
  compareText,
  ContentError,
  LIBRARY_DIR,
  loadLibrary,
  readToolkitVersion,
  REFERENCE_PREFIX,
} from "./library.js";
import { AGENTS_RULES, type Plan, render, SKILLS_DIR } from "./render.js";
import { applyPlan, ConflictError, diffPlan, type Drift, LockError, readLock } from "./write.js";

/** Exit code for success. */
export const EXIT_OK = 0;

/** Exit code when `check` finds the repo differs from what `sync` would write. */
export const EXIT_DRIFT = 1;

/** Exit code for invalid config or content, a version mismatch, conflicting files, or bad usage. */
export const EXIT_ERROR = 2;

/** Published package name, used in install hints. */
export const PACKAGE_NAME = "@rbhenao/agent-toolkit";

/** Width of the longest change verb in an upgrade summary, so item names line up. */
const CHANGE_WIDTH = "removed".length;

/** Explain a pin that differs from the installed version, and how to fix it. */
const PIN_MISMATCH: Readonly<Record<Exclude<PinStatus, "match">, (pinned: string, installed: string) => string>> = {
  behind: (pinned, installed) =>
    `${CONFIG_FILE} pins ${pinned} but ${installed} is installed; ` +
    `run agent-toolkit upgrade, or use npx ${PACKAGE_NAME}@${pinned}`,
  ahead: (pinned, installed) =>
    `${CONFIG_FILE} pins ${pinned} but ${installed} is installed; install ${PACKAGE_NAME}@${pinned}`,
};

/** Where command output goes, one line per call. */
export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Everything a command depends on from its environment. */
export interface Context {
  readonly root: string;
  readonly io: Io;
  /** Installed toolkit version, which is also the bundled library's version. */
  readonly version: string;
  readonly libraryDir: string;
}

interface Command {
  readonly summary: string;
  readonly run: (context: Context) => number;
}

/** Write a starter `agent-toolkit.yaml` pinned to the installed version, then sync. */
function init(context: Context): number {
  createConfig(context.root, starterConfig(context.version));
  context.io.out(`created ${CONFIG_FILE} pinned to ${context.version}`);

  return sync(context);
}

/** Print the library's rules, skills, and references, marking the rules and skills the repo enables. */
function list({ root, io, version, libraryDir }: Context): number {
  const library = loadLibrary(libraryDir);
  const config = existsSync(join(root, CONFIG_FILE)) ? readConfig(root) : undefined;

  io.out(
    config === undefined
      ? `agent-toolkit ${version}; no ${CONFIG_FILE} here`
      : `agent-toolkit ${version}; ${CONFIG_FILE} pins ${config.toolkit}; * marks enabled rules and skills`,
  );
  printTable(io, "rules", [...library.rules.values()], (name) => config?.rules.has(name) ?? false);
  printTable(io, "skills", [...library.skills.values()], (name) => config?.skills.includes(name) ?? false);
  printTable(
    io,
    "references",
    [...library.references.keys()].map((id) => ({ name: id, description: "" })),
    () => false,
  );
  return EXIT_OK;
}

/** Write the files the config resolves to; refuse when the pin differs from the installed version. */
function sync(context: Context): number {
  const config = readConfig(context.root);
  if (!pinMatches(context, config.toolkit)) {
    return EXIT_ERROR;
  }

  const drift = applyPlan(context.root, planFor(context, config), readLock(context.root));
  printApplied(context.io, drift);
  return EXIT_OK;
}

/** Move the pin to the installed version and sync, reporting changed items; a matching pin is left as is. */
function upgrade(context: Context): number {
  const { root, io, version } = context;
  const text = readConfigText(root);
  const config = parseConfig(text);

  const status = comparePin(config.toolkit, version);
  if (status === "match") {
    io.out(`${CONFIG_FILE} already pins ${version}`);
    return EXIT_OK;
  }
  if (status === "ahead") {
    io.err(PIN_MISMATCH.ahead(config.toolkit, version));
    return EXIT_ERROR;
  }

  const upgraded = setPin(text, version);
  const drift = applyPlan(root, planFor(context, parseConfig(upgraded)), readLock(root));
  writeConfigText(root, upgraded);
  io.out(`upgraded ${CONFIG_FILE} from ${config.toolkit} to ${version}`);
  for (const line of changedItems(drift)) {
    io.out(line);
  }
  printApplied(io, drift);
  return EXIT_OK;
}

/** Report drift without writing; a version mismatch is reported as an error, not as drift. */
function check(context: Context): number {
  const { root, io } = context;
  const config = readConfig(root);
  if (!pinMatches(context, config.toolkit)) {
    return EXIT_ERROR;
  }

  const drift = diffPlan(root, planFor(context, config), readLock(root));
  const lines = [
    ...drift.stale.map((path) => `  stale     ${path}`),
    ...drift.missing.map((path) => `  missing   ${path}`),
    ...drift.orphaned.map((path) => `  orphaned  ${path}`),
    ...drift.conflicts.map((path) => `  conflict  ${path}`),
  ];
  if (lines.length === 0) {
    io.out(`generated files match ${CONFIG_FILE}`);
    return EXIT_OK;
  }

  io.out(`generated files differ from ${CONFIG_FILE}:`);
  for (const line of lines) {
    io.out(line);
  }
  io.out(
    drift.conflicts.length > 0
      ? "move or delete conflicting paths, then run agent-toolkit sync"
      : "run agent-toolkit sync to update them",
  );
  return EXIT_DRIFT;
}

/** Subcommands by name, in the order usage lists them. */
export const COMMANDS: Readonly<Record<string, Command>> = {
  init: { summary: `Write a starter ${CONFIG_FILE} pinned to the installed version, then sync`, run: init },
  sync: { summary: `Write the files ${CONFIG_FILE} resolves to`, run: sync },
  upgrade: { summary: "Move the pin to the installed version and sync; a matching pin is left as is", run: upgrade },
  check: { summary: "Exit 1 when generated files differ from what sync would write", run: check },
  list: { summary: "Show the library's rules, skills, and references", run: list },
};

/** Run one command and return its exit code. Errors the user can fix are printed without a stack trace. */
export function main(argv: readonly string[], context: Context = defaultContext()): number {
  const { io } = context;
  const parsed = parseCommandLine(argv);
  if (parsed === "help") {
    printUsage(io.out);
    return EXIT_OK;
  }
  const command = parsed === undefined ? undefined : COMMANDS[parsed];
  if (command === undefined) {
    printUsage(io.err);
    return EXIT_ERROR;
  }

  try {
    return command.run(context);
  } catch (error) {
    if (
      error instanceof ConfigError ||
      error instanceof ContentError ||
      error instanceof ConflictError ||
      error instanceof LockError
    ) {
      io.err(`agent-toolkit: ${error.message}`);
      return EXIT_ERROR;
    }
    throw error;
  }
}

/** Return the command name, `help`, or `undefined` for anything else. */
function parseCommandLine(argv: readonly string[]): string | undefined {
  try {
    const { positionals, values } = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: { help: { type: "boolean", short: "h" } },
    });
    if (values.help === true) {
      return "help";
    }
    return positionals.length === 1 ? positionals[0] : undefined;
  } catch (error) {
    if (
      error instanceof TypeError &&
      "code" in error &&
      typeof error.code === "string" &&
      error.code.startsWith("ERR_PARSE_ARGS")
    ) {
      return undefined;
    }
    throw error;
  }
}

function defaultContext(): Context {
  return {
    root: process.cwd(),
    io: {
      out: (line) => {
        process.stdout.write(`${line}\n`);
      },
      err: (line) => {
        process.stderr.write(`${line}\n`);
      },
    },
    version: readToolkitVersion(),
    libraryDir: LIBRARY_DIR,
  };
}

function planFor({ root, libraryDir }: Context, config: Config): Plan {
  return render(resolveConfig(config, loadLibrary(libraryDir), readLocal(root)));
}

/** Print why the pin differs from the installed version, if it does, and report whether they match. */
function pinMatches({ io, version }: Context, pinned: string): boolean {
  const status = comparePin(pinned, version);
  if (status !== "match") {
    io.err(PIN_MISMATCH[status](pinned, version));
  }
  return status === "match";
}

function printApplied(io: Io, drift: Drift): void {
  const lines = [
    ...drift.missing.map((path) => `  created  ${path}`),
    ...drift.stale.map((path) => `  updated  ${path}`),
    ...drift.orphaned.map((path) => `  removed  ${path}`),
  ];
  if (lines.length === 0) {
    io.out("generated files are up to date");
    return;
  }

  io.out(`synced ${String(lines.length)} ${lines.length === 1 ? "path" : "paths"}:`);
  for (const line of lines) {
    io.out(line);
  }
}

/**
 * Label drift by rule, skill, and reference. Reads only the neutral `.agents/` copies, so a change confined to a
 * tool's copy appears in the path list but not here.
 */
function changedItems(drift: Drift): readonly string[] {
  const states = new Map<string, Set<keyof Drift>>();
  for (const state of ["missing", "stale", "orphaned"] as const) {
    for (const path of drift[state]) {
      const item = itemLabel(path);
      if (item !== undefined) {
        states.set(item, (states.get(item) ?? new Set()).add(state));
      }
    }
  }

  return [...states]
    .toSorted(([a], [b]) => compareText(a, b))
    .map(([item, seen]) => `  ${changeLabel(seen).padEnd(CHANGE_WIDTH)} ${item}`);
}

/** An item is added when all its paths were created, removed when all were deleted, and changed otherwise. */
function changeLabel(seen: ReadonlySet<keyof Drift>): string {
  if (seen.size === 1 && seen.has("missing")) {
    return "added";
  }
  if (seen.size === 1 && seen.has("orphaned")) {
    return "removed";
  }
  return "changed";
}

/** Name the rule, skill, or reference a generated `.agents/` path belongs to. */
function itemLabel(path: string): string | undefined {
  if (path.startsWith(`${AGENTS_RULES.dir}/`)) {
    return `rule ${basename(path, AGENTS_RULES.extension)}`;
  }
  if (path.startsWith(`${SKILLS_DIR}/`)) {
    return `skill ${path.slice(SKILLS_DIR.length + 1).replace(/\/.*$/, "")}`;
  }
  if (path.startsWith(REFERENCE_PREFIX)) {
    return `reference ${path.slice(REFERENCE_PREFIX.length)}`;
  }
  return undefined;
}

function printTable(
  io: Io,
  heading: string,
  items: readonly { readonly name: string; readonly description: string }[],
  enabled: (name: string) => boolean,
): void {
  io.out("");
  io.out(`${heading}:`);
  if (items.length === 0) {
    io.out("  (none)");
    return;
  }

  const width = Math.max(...items.map((item) => item.name.length));
  for (const item of items) {
    io.out(`${enabled(item.name) ? "*" : " "} ${item.name.padEnd(width)}  ${item.description}`.trimEnd());
  }
}

function printUsage(print: (line: string) => void): void {
  const width = Math.max(...Object.keys(COMMANDS).map((name) => name.length));
  print("Usage: agent-toolkit <command>");
  print("");
  print("Commands:");
  for (const [name, command] of Object.entries(COMMANDS)) {
    print(`  ${name.padEnd(width)}  ${command.summary}`);
  }
}

if (import.meta.main) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = EXIT_ERROR;
  }
}
