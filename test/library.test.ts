import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compareText,
  ContentError,
  loadLibrary,
  parseExtension,
  parseRule,
  parseSkill,
  readSkillFiles,
  readToolkitVersion,
} from "../src/library.js";

const RULE = [
  "---",
  "description: Apply when editing playbooks",
  "paths:",
  "  - ansible/**/*.yml",
  "references:",
  "  - ansible/gpa.md",
  "---",
  "",
  "Read `.agents/references/ansible/gpa.md` first.",
  "",
].join("\n");

const SKILL = ["---", "name: sliced", "description: Implement one slice", "---", "", "# Sliced", ""].join("\n");

const REFERENCE = [
  "---",
  "title: GPA",
  "source: https://example.com/gpa",
  "upstream: https://example.com/gpa/commit/abc",
  "retrieved: 2026-10-22",
  "license: MIT",
  "---",
  "",
  "# GPA",
  "",
].join("\n");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write `files` under a fresh temporary directory and return its path. */
function makeTree(files: Readonly<Record<string, string | Uint8Array>>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-toolkit-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function expectContentError(action: () => unknown, message: RegExp): void {
  expect(action).toThrow(ContentError);
  expect(action).toThrow(message);
}

describe("parseRule", () => {
  it("parses frontmatter and trims the body", () => {
    expect(parseRule("ansible-design", RULE)).toEqual({
      name: "ansible-design",
      description: "Apply when editing playbooks",
      paths: ["ansible/**/*.yml"],
      references: ["ansible/gpa.md"],
      body: "Read `.agents/references/ansible/gpa.md` first.",
    });
  });

  it("treats absent paths and references as empty, so the rule always applies", () => {
    const rule = parseRule("committing", "---\ndescription: Commit only when asked\n---\n\nBody\n");

    expect(rule.paths).toEqual([]);
    expect(rule.references).toEqual([]);
  });

  it("accepts empty frontmatter fences before reporting the missing description", () => {
    expectContentError(() => parseRule("empty", "---\n---\nBody\n"), /frontmatter must be a mapping/);
  });

  it.each([
    ["a name that is not kebab-case", "Bad_Name", RULE, /name must be kebab-case/],
    ["no frontmatter", "x", "Body\n", /must start with a --- frontmatter line/],
    ["unclosed frontmatter", "x", "---\ndescription: x\n", /no closing ---/],
    ["a closing fence that is not a whole line", "x", "---\ndescription: x\n----\nBody\n", /no closing ---/],
    ["CRLF line endings", "x", "---\r\ndescription: x\r\n---\r\nBody\r\n", /use LF line endings, not CRLF/],
    ["invalid YAML", "x", "---\ndescription: [\n---\nBody\n", /invalid frontmatter/],
    ["duplicate keys", "x", "---\ndescription: a\ndescription: b\n---\nBody\n", /invalid frontmatter/],
    ["a non-mapping frontmatter", "x", "---\n- a\n---\nBody\n", /must be a mapping/],
    ["a missing description", "x", "---\npaths: [src/**]\n---\nBody\n", /description must be a non-empty string/],
    ["an unknown key", "x", "---\ndescription: x\nglobs: [a]\n---\nBody\n", /unknown frontmatter keys: globs/],
    ["paths that are not a list", "x", "---\ndescription: x\npaths: src/**\n---\nBody\n", /paths must be a list/],
    ["an absolute path", "x", "---\ndescription: x\npaths: [/etc/x]\n---\nBody\n", /paths must be a list/],
    ["a parent path", "x", "---\ndescription: x\npaths: [../x]\n---\nBody\n", /paths must be a list/],
    ["duplicate paths", "x", "---\ndescription: x\npaths: [a, a]\n---\nBody\n", /paths has duplicate entries/],
    ["an empty body", "x", "---\ndescription: x\n---\n\n", /body is empty/],
    ["a tool directory in the body", "x", "---\ndescription: x\n---\nSee .claude/rules/a.md\n", /\.claude\//],
    [
      "a citation missing from frontmatter",
      "x",
      "---\ndescription: x\n---\nRead .agents/references/a.md\n",
      /missing from frontmatter: a\.md/,
    ],
    [
      "a listed reference the body never cites",
      "x",
      "---\ndescription: x\nreferences: [a.md]\n---\nBody\n",
      /never cites: a\.md/,
    ],
  ])("rejects %s", (_case, name, text, message) => {
    expectContentError(() => parseRule(name, text), message);
  });
});

describe("parseExtension", () => {
  it("returns the trimmed text", () => {
    expect(parseExtension("documentation-drift", "\nAlso audit `docs/`.\n\n")).toBe("Also audit `docs/`.");
  });

  it.each([
    ["a name that is not kebab-case", "Docs", "x", /name must be kebab-case/],
    ["empty text", "docs", " \n", /is empty/],
    ["frontmatter", "docs", "---\npaths: [a]\n---\nx\n", /extensions have no frontmatter/],
    ["a tool directory", "docs", "See .codex/agents/x.toml", /names tool directory \.codex\//],
    ["a reference citation", "docs", "Read .agents/references/a.md", /extensions cannot cite references/],
  ])("rejects %s", (_case, name, text, message) => {
    expectContentError(() => parseExtension(name, text), message);
  });
});

describe("parseSkill", () => {
  it("returns the skill with its files", () => {
    const files = new Map([
      ["SKILL.md", SKILL],
      ["scripts/run.sh", "echo hi\n"],
    ]);

    expect(parseSkill("sliced", files)).toEqual({ name: "sliced", description: "Implement one slice", files });
  });

  it("accepts a SKILL.md whose closing fence ends the file", () => {
    const files = new Map([["SKILL.md", "---\nname: sliced\ndescription: Implement one slice\n---"]]);

    expect(parseSkill("sliced", files).description).toBe("Implement one slice");
  });

  it("accepts a name and description at the Agent Skills length limits", () => {
    const name = "a".repeat(64);
    const description = "d".repeat(1024);
    const files = new Map([["SKILL.md", `---\nname: ${name}\ndescription: ${description}\n---\n`]]);

    expect(parseSkill(name, files)).toMatchObject({ name, description });
  });

  it.each([
    ["a name that is not kebab-case", "Sliced", new Map([["SKILL.md", SKILL]]), /name must be kebab-case/],
    ["a name over 64 characters", "a".repeat(65), new Map([["SKILL.md", SKILL]]), /name must be at most 64/],
    [
      "a description over 1024 characters",
      "sliced",
      new Map([["SKILL.md", `---\nname: sliced\ndescription: ${"d".repeat(1025)}\n---\n`]]),
      /description must be at most 1024 characters/,
    ],
    ["a missing SKILL.md", "sliced", new Map([["README.md", SKILL]]), /missing SKILL\.md/],
    ["a mismatched name", "other", new Map([["SKILL.md", SKILL]]), /name must be other/],
    [
      "a missing description",
      "sliced",
      new Map([["SKILL.md", "---\nname: sliced\n---\n"]]),
      /description must be a non-empty string/,
    ],
    [
      "a tool directory in a supporting file",
      "sliced",
      new Map([
        ["SKILL.md", SKILL],
        ["notes.md", "Edit .cursor/rules/x.mdc"],
      ]),
      /notes\.md: names tool directory \.cursor\//,
    ],
  ])("rejects %s", (_case, name, files, message) => {
    expectContentError(() => parseSkill(name, files), message);
  });
});

describe("readSkillFiles", () => {
  it("keys nested files by sorted relative path and skips ignored names at any depth", () => {
    const dir = makeTree({
      "SKILL.md": SKILL,
      "scripts/run.sh": "echo hi\n",
      ".DS_Store": "x",
      ".gitkeep": "",
      "a.md": "a",
      "__pycache__/a.cpython-314.pyc": new Uint8Array([0xff, 0x0d]),
      "scripts/__pycache__/run.cpython-314.pyc": new Uint8Array([0xff, 0x0d]),
    });

    const files = readSkillFiles({ path: dir, label: "skills/sliced" });

    expect([...files.keys()]).toEqual(["SKILL.md", "a.md", "scripts/run.sh"]);
    expect(files.get("scripts/run.sh")).toBe("echo hi\n");
  });

  it("rejects symlinks", () => {
    const dir = makeTree({ "SKILL.md": SKILL });
    symlinkSync("SKILL.md", join(dir, "link.md"));

    expectContentError(
      () => readSkillFiles({ path: dir, label: "skills/sliced" }),
      /^skills\/sliced\/link\.md: only regular files and directories/,
    );
  });

  it("rejects files that are not UTF-8", () => {
    const dir = makeTree({ "SKILL.md": SKILL, "image.bin": new Uint8Array([0xff, 0xfe]) });

    expectContentError(
      () => readSkillFiles({ path: dir, label: "skills/sliced" }),
      /^skills\/sliced\/image\.bin: not UTF-8/,
    );
  });
});

describe("loadLibrary", () => {
  it("loads rules, skills, and nested references", () => {
    const dir = makeTree({
      "rules/ansible-design.md": RULE,
      "rules/committing.md": "---\ndescription: Commit only when asked\n---\nBody\n",
      "skills/sliced/SKILL.md": SKILL,
      "references/ansible/gpa.md": REFERENCE,
    });

    const library = loadLibrary(dir);

    expect([...library.rules.keys()]).toEqual(["ansible-design", "committing"]);
    expect([...library.skills.keys()]).toEqual(["sliced"]);
    expect(library.references.get("ansible/gpa.md")).toEqual({ id: "ansible/gpa.md", content: REFERENCE });
  });

  it.each([
    ["missing content directories", {}],
    ["placeholder-only directories", { "rules/.gitkeep": "", "skills/.gitkeep": "", "references/.gitkeep": "" }],
  ])("treats %s as empty", (_case, files) => {
    const library = loadLibrary(makeTree(files));

    expect(library.rules.size + library.skills.size + library.references.size).toBe(0);
  });

  it("loads the bundled library with exactly the pinned rules, skills, and references", () => {
    const library = loadLibrary();

    expect([...library.rules.keys()]).toEqual([
      "agent-toolkit",
      "ai-manifesto-python",
      "ai-manifesto-typescript",
      "ansible-design",
      "committing",
      "multi-agent-workflow",
    ]);
    expect([...library.skills.keys()]).toEqual([
      "agent-toolkit-authoring",
      "documentation-drift",
      "sliced-implementation",
      "stubbed-implementation",
    ]);
    expect([...library.references.keys()]).toEqual(["ansible/good-practices-for-ansible.md"]);
  });

  it("scopes each manifesto to its language and always applies committing", () => {
    const { rules } = loadLibrary();

    expect(rules.get("ai-manifesto-python")?.paths).toEqual(["**/*.py"]);
    expect(rules.get("ai-manifesto-typescript")?.paths).toEqual(["**/*.ts", "**/*.tsx"]);
    expect(rules.get("committing")?.paths).toEqual([]);
  });

  it.each([
    ["a rule citing a missing reference", { "rules/a.md": RULE }, /^library\/rules\/a\.md: cites references/],
    ["a rule that is not .md", { "rules/a.txt": "x" }, /rules must be \.md files/],
    ["a nested rule", { "rules/sub/a.md": RULE }, /rules must be \.md files directly under rules\//],
    ["a file in skills/", { "skills/a.md": SKILL }, /skills must be directories/],
    ["a file named rules", { rules: "x" }, /rules: must be a directory/],
    ["a file named skills", { skills: "x" }, /skills: must be a directory/],
    ["a file named references", { references: "x" }, /references: must be a directory/],
    ["a reference that is not .md", { "references/a.txt": REFERENCE }, /references must be \.md files/],
    [
      "a reference missing a provenance key",
      { "references/a.md": REFERENCE.replace("license: MIT\n", "") },
      /license must be a non-empty string/,
    ],
    [
      "a reference with an unknown key",
      { "references/a.md": REFERENCE.replace("license: MIT\n", "license: MIT\nauthor: x\n") },
      /unknown frontmatter keys: author/,
    ],
    [
      "a reference with a malformed date",
      { "references/a.md": REFERENCE.replace("2026-10-22", "Oct 22 2026") },
      /retrieved must be a YYYY-MM-DD date/,
    ],
  ])("rejects %s", (_case, files, message) => {
    const dir = makeTree(files);

    expectContentError(() => loadLibrary(dir), message);
  });
});

describe("compareText", () => {
  it("orders by code unit and treats equal text as equal", () => {
    expect(["b", "B", "a", "b"].toSorted(compareText)).toEqual(["B", "a", "b", "b"]);
    expect(compareText("a", "a")).toBe(0);
  });
});

describe("readToolkitVersion", () => {
  it("reads the installed package version", () => {
    const manifest: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

    expect(manifest).toMatchObject({ version: readToolkitVersion() });
  });

  it.each([["1.0"], ["v1.0.0"], ["01.0.0"], ["1.0.0-beta.1"], [7]])("rejects version %s", (version) => {
    const file = join(makeTree({ "package.json": JSON.stringify({ version }) }), "package.json");

    expect(() => readToolkitVersion(file)).toThrow(/version must be MAJOR\.MINOR\.PATCH/);
  });
});
