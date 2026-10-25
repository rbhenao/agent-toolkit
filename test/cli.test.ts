import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { COMMANDS, type Context, EXIT_DRIFT, EXIT_ERROR, EXIT_OK, main, PACKAGE_NAME } from "../src/cli.js";
import { LOCK_FILE } from "../src/write.js";

const LIBRARY = {
  "rules/agent-toolkit.md": "---\ndescription: Change guidance through sources\n---\n\nRun sync after changes.\n",
  "skills/agent-toolkit-authoring/SKILL.md":
    "---\nname: agent-toolkit-authoring\ndescription: Add repo guidance\n---\n\n# Authoring\n",
  "rules/committing.md": "---\ndescription: Commit only when asked\n---\n\nStage only your files.\n",
  "rules/ansible-design.md": [
    "---",
    "description: Keep roles small",
    "paths: [ansible/**]",
    "references: [ansible/gpa.md]",
    "---",
    "",
    "Read `.agents/references/ansible/gpa.md`.",
    "",
  ].join("\n"),
  "skills/sliced/SKILL.md": "---\nname: sliced\ndescription: Implement one slice\n---\n\n# Sliced\n",
  "references/ansible/gpa.md": [
    "---",
    "title: GPA",
    "source: https://example.com",
    "upstream: https://example.com/abc",
    "retrieved: 2026-10-22",
    "license: MIT",
    "---",
    "",
    "# GPA",
    "",
  ].join("\n"),
};

const CONFIG = [
  "# Comment kept across upgrades",
  "toolkit: 1.2.0",
  "targets: [claude, cursor]",
  "rules:",
  "  committing:",
  "  ansible-design:",
  "skills:",
  "  - sliced",
  "",
].join("\n");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write `files` under a fresh temporary directory and return its path. */
function makeTree(files: Readonly<Record<string, string>> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "agent-toolkit-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    put(root, path, content);
  }
  return root;
}

function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

/** Run the CLI in `root` against the fixture library with `version` installed, capturing output. */
function run(argv: readonly string[], root: string, version = "1.2.0") {
  const out: string[] = [];
  const err: string[] = [];
  const context: Context = {
    root,
    version,
    libraryDir: makeTree(LIBRARY),
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
  };

  const code = main(argv, context);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("usage", () => {
  it("prints usage for --help", () => {
    const result = run(["--help"], makeTree());

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toMatch(/^Usage: agent-toolkit <command>/);
    for (const name of Object.keys(COMMANDS)) {
      expect(result.out).toContain(`  ${name} `);
    }
  });

  it.each([
    ["no command", []],
    ["an unknown command", ["deploy"]],
    ["an extra argument", ["sync", "now"]],
    ["an unknown option", ["sync", "--force"]],
  ])("rejects %s with usage on stderr", (_case, argv) => {
    const result = run(argv, makeTree());

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(/^Usage: agent-toolkit/);
  });

  it("names the published package in install hints", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest).toMatchObject({ name: PACKAGE_NAME });
  });
});

describe("init", () => {
  it("writes a starter config pinned to the installed version and syncs", () => {
    const root = makeTree();

    const result = run(["init"], root, "1.4.0");

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toContain("created agent-toolkit.yaml pinned to 1.4.0");
    expect(read(root, "agent-toolkit.yaml")).toContain("toolkit: 1.4.0\n");
    expect(JSON.parse(read(root, LOCK_FILE))).toEqual({
      paths: [
        ".agents/rules/agent-toolkit.md",
        ".agents/skills/agent-toolkit-authoring/SKILL.md",
        LOCK_FILE,
        ".claude/rules/agent-toolkit.md",
        ".claude/skills/agent-toolkit-authoring",
        ".cursor/rules/agent-toolkit.mdc",
        ".cursor/skills/agent-toolkit-authoring",
      ],
    });
    expect(run(["check"], root, "1.4.0").code).toBe(EXIT_OK);
  });

  it("refuses to replace an existing config", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    const result = run(["init"], root);

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe("agent-toolkit: agent-toolkit.yaml already exists; edit it, then run agent-toolkit sync");
    expect(read(root, "agent-toolkit.yaml")).toBe(CONFIG);
  });
});

describe("sync and check", () => {
  it("round-trips: check finds drift, sync fixes it, a hand edit is caught and undone", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    const before = run(["check"], root);
    expect(before.code).toBe(EXIT_DRIFT);
    expect(before.out).toContain("  missing   .claude/rules/committing.md");
    expect(before.out).toContain("run agent-toolkit sync to update them");

    const synced = run(["sync"], root);
    expect(synced.code).toBe(EXIT_OK);
    expect(synced.out).toContain("  created  .agents/references/ansible/gpa.md");
    expect(readlinkSync(join(root, ".cursor/skills/sliced"))).toBe("../../.agents/skills/sliced");
    expect(run(["check"], root)).toMatchObject({ code: EXIT_OK, out: "generated files match agent-toolkit.yaml" });

    put(root, ".claude/rules/committing.md", "edited\n");
    expect(run(["check"], root)).toMatchObject({ code: EXIT_DRIFT });
    expect(run(["check"], root).out).toContain("  stale     .claude/rules/committing.md");

    expect(run(["sync"], root).out).toBe("synced 1 path:\n  updated  .claude/rules/committing.md");
    expect(run(["sync"], root).out).toBe("generated files are up to date");
    expect(run(["check"], root).code).toBe(EXIT_OK);
  });

  it("includes repo-only rules, skills, and extensions from .agent-toolkit/", () => {
    const root = makeTree({
      "agent-toolkit.yaml": CONFIG,
      ".agent-toolkit/rules/wikidata.md": "---\ndescription: Be polite to Wikidata\n---\n\nThrottle.\n",
      ".agent-toolkit/skills/qa/SKILL.md": "---\nname: qa\ndescription: Run QA\n---\n\n# QA\n",
      ".agent-toolkit/extensions/committing.md": "Also sign off.\n",
    });

    expect(run(["sync"], root).code).toBe(EXIT_OK);

    expect(read(root, ".claude/rules/wikidata.md")).toContain("Throttle.");
    expect(read(root, ".agents/rules/committing.md")).toMatch(/Stage only your files\.\n\nAlso sign off\.\n$/);
    expect(existsSync(join(root, ".claude/skills/qa/SKILL.md"))).toBe(true);
  });

  it("removes generated files the config no longer enables", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });
    run(["sync"], root);
    put(root, "agent-toolkit.yaml", CONFIG.replace("  - sliced\n", ""));

    const result = run(["sync"], root);

    expect(result.out).toContain("  removed  .claude/skills/sliced");
    expect(existsSync(join(root, ".agents/skills"))).toBe(false);
  });

  it("reports conflicts in check and refuses to sync over them", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG, ".claude/rules/committing.md": "mine\n" });

    const checked = run(["check"], root);
    expect(checked.code).toBe(EXIT_DRIFT);
    expect(checked.out).toContain("  conflict  .claude/rules/committing.md");
    expect(checked.out).toContain("move or delete conflicting paths");

    const synced = run(["sync"], root);
    expect(synced.code).toBe(EXIT_ERROR);
    expect(synced.err).toMatch(/^agent-toolkit: refusing to overwrite paths .*\.claude\/rules\/committing\.md/);
    expect(read(root, ".claude/rules/committing.md")).toBe("mine\n");
  });

  it.each([["sync"], ["check"]])("%s refuses a pin behind the installed version", (command) => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    const result = run([command], root, "1.3.0");

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe(
      "agent-toolkit.yaml pins 1.2.0 but 1.3.0 is installed; " +
        `run agent-toolkit upgrade, or use npx ${PACKAGE_NAME}@1.2.0`,
    );
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  it.each([["sync"], ["check"]])("%s refuses a pin ahead of the installed version", (command) => {
    const result = run([command], makeTree({ "agent-toolkit.yaml": CONFIG }), "1.1.9");

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe(`agent-toolkit.yaml pins 1.2.0 but 1.1.9 is installed; install ${PACKAGE_NAME}@1.2.0`);
  });

  it.each([
    ["a missing config", {}, /^agent-toolkit: no agent-toolkit\.yaml in .*; run agent-toolkit init$/],
    ["an invalid config", { "agent-toolkit.yaml": "toolkit: 1.2\n" }, /toolkit must be an exact/],
    [
      "an unknown library rule",
      { "agent-toolkit.yaml": CONFIG.replace("committing:", "nope:") },
      /nope is not a library rule/,
    ],
    [
      "invalid local content",
      { "agent-toolkit.yaml": CONFIG, ".agent-toolkit/rules/bad.md": "no frontmatter\n" },
      /^agent-toolkit: \.agent-toolkit\/rules\/bad\.md: must start with a --- frontmatter line$/,
    ],
  ])("prints %s without a stack trace", (_case, files, message) => {
    const result = run(["sync"], makeTree(files));

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toMatch(message);
  });
});

describe("upgrade", () => {
  it("moves the pin, keeps the rest of the config, syncs, and summarizes changed items", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG.replace("1.2.0", "1.0.0") });

    const result = run(["upgrade"], root, "1.2.0");

    expect(result.code).toBe(EXIT_OK);
    expect(read(root, "agent-toolkit.yaml")).toBe(CONFIG);
    expect(result.out).toContain("upgraded agent-toolkit.yaml from 1.0.0 to 1.2.0");
    expect(result.out).toContain("  added   rule ansible-design");
    expect(result.out).toContain("  added   skill sliced");
    expect(result.out).toContain("  added   reference ansible/gpa.md");
    expect(run(["check"], root).code).toBe(EXIT_OK);
  });

  it("does nothing when the pin already matches", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    expect(run(["upgrade"], root)).toMatchObject({ code: EXIT_OK, out: "agent-toolkit.yaml already pins 1.2.0" });
    expect(existsSync(join(root, ".agents"))).toBe(false);
  });

  it("refuses to move the pin backward", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    const result = run(["upgrade"], root, "1.1.0");

    expect(result.code).toBe(EXIT_ERROR);
    expect(result.err).toBe(`agent-toolkit.yaml pins 1.2.0 but 1.1.0 is installed; install ${PACKAGE_NAME}@1.2.0`);
    expect(read(root, "agent-toolkit.yaml")).toBe(CONFIG);
  });

  it("leaves the pin unchanged when the sync would conflict", () => {
    const old = CONFIG.replace("1.2.0", "1.0.0");
    const root = makeTree({ "agent-toolkit.yaml": old, ".claude/rules/committing.md": "mine\n" });

    expect(run(["upgrade"], root).code).toBe(EXIT_ERROR);
    expect(read(root, "agent-toolkit.yaml")).toBe(old);
  });

  it("reports changed and removed items from the neutral copies", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG.replace("1.2.0", "1.0.0") });
    run(["upgrade"], root, "1.0.0");
    run(["sync"], root, "1.0.0");
    put(root, ".agents/rules/committing.md", "edited\n");
    put(root, "agent-toolkit.yaml", CONFIG.replace("1.2.0", "1.0.0").replace("  - sliced\n", ""));

    const result = run(["upgrade"], root, "1.2.0");

    expect(result.out).toContain("  changed rule committing");
    expect(result.out).toContain("  removed skill sliced");
  });
});

describe("list", () => {
  it("shows the library and marks what the repo enables", () => {
    const result = run(["list"], makeTree({ "agent-toolkit.yaml": CONFIG.replace("  ansible-design:\n", "") }));

    expect(result.code).toBe(EXIT_OK);
    expect(result.out.split("\n")).toEqual([
      "agent-toolkit 1.2.0; agent-toolkit.yaml pins 1.2.0; * marks enabled rules and skills",
      "",
      "rules:",
      "  agent-toolkit   Change guidance through sources",
      "  ansible-design  Keep roles small",
      "* committing      Commit only when asked",
      "",
      "skills:",
      "  agent-toolkit-authoring  Add repo guidance",
      "* sliced                   Implement one slice",
      "",
      "references:",
      "  ansible/gpa.md",
    ]);
  });

  it("works without a config", () => {
    const result = run(["list"], makeTree());

    expect(result.code).toBe(EXIT_OK);
    expect(result.out).toMatch(/^agent-toolkit 1\.2\.0; no agent-toolkit\.yaml here\n/);
    expect(result.out).not.toContain("*");
  });
});
