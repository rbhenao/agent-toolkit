import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  comparePin,
  type Config,
  ConfigError,
  type LocalSources,
  parseConfig,
  readConfig,
  readLocal,
  resolveConfig,
  setPin,
  starterConfig,
} from "../src/config.js";
import { ContentError, type Library, type LibraryRule, type LibrarySkill, loadLibrary } from "../src/library.js";

const CONFIG = [
  "toolkit: 1.2.0",
  "targets: [claude, cursor]",
  "rules:",
  "  committing:",
  "  ansible-design:",
  "    description: Apply when editing infra",
  "    paths:",
  "      - infra/**/*.yml",
  "skills:",
  "  - sliced",
  "",
].join("\n");

const LOCAL_RULE = "---\ndescription: Be polite to Wikidata\npaths: [src/wikidata/**]\n---\n\nThrottle requests.\n";

const SKILL = "---\nname: qa-sandbox\ndescription: Run checks on QA\n---\n\n# QA\n";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Write `files` under a fresh temporary directory and return its path. */
function makeTree(files: Readonly<Record<string, string>>): string {
  const root = mkdtempSync(join(tmpdir(), "agent-toolkit-"));
  roots.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

function expectError(action: () => unknown, type: typeof ConfigError | typeof ContentError, message: RegExp): void {
  expect(action).toThrow(type);
  expect(action).toThrow(message);
}

function rule(name: string, overrides: Partial<LibraryRule> = {}): LibraryRule {
  return { name, description: `${name} description`, paths: [], references: [], body: `${name} body`, ...overrides };
}

function skill(name: string): LibrarySkill {
  return { name, description: `${name} description`, files: new Map([["SKILL.md", `${name} skill`]]) };
}

function config(overrides: Partial<Config> = {}): Config {
  return { toolkit: "1.0.0", targets: ["claude"], rules: new Map(), skills: [], ...overrides };
}

const LIBRARY: Library = {
  rules: new Map([
    ["ansible-design", rule("ansible-design", { paths: ["ansible/**"], references: ["ansible/gpa.md"] })],
    ["committing", rule("committing")],
    ["neo4j", rule("neo4j", { references: ["neo4j/ops.md", "ansible/gpa.md"] })],
  ]),
  skills: new Map([
    ["sliced", skill("sliced")],
    ["stubbed", skill("stubbed")],
  ]),
  references: new Map([
    ["ansible/gpa.md", { id: "ansible/gpa.md", content: "gpa" }],
    ["neo4j/ops.md", { id: "neo4j/ops.md", content: "ops" }],
  ]),
};

const NO_LOCAL: LocalSources = { rules: new Map(), skills: new Map(), extensions: new Map() };

describe("parseConfig", () => {
  it("parses the pin, targets, rule settings, and skills", () => {
    expect(parseConfig(CONFIG)).toEqual({
      toolkit: "1.2.0",
      targets: ["claude", "cursor"],
      rules: new Map([
        ["committing", {}],
        ["ansible-design", { description: "Apply when editing infra", paths: ["infra/**/*.yml"] }],
      ]),
      skills: ["sliced"],
    });
  });

  it.each([
    ["absent", "toolkit: 1.0.0\ntargets: [codex]\n"],
    ["empty", "toolkit: 1.0.0\ntargets: [codex]\nrules:\nskills:\n"],
  ])("enables nothing when rules and skills are %s", (_case, text) => {
    const parsed = parseConfig(text);

    expect(parsed.rules.size).toBe(0);
    expect(parsed.skills).toEqual([]);
  });

  it("accepts empty paths, so a rule always applies", () => {
    const parsed = parseConfig("toolkit: 1.0.0\ntargets: [claude]\nrules:\n  committing:\n    paths: []\n");

    expect(parsed.rules.get("committing")).toEqual({ paths: [] });
  });

  it.each([
    ["invalid YAML", "toolkit: [\n", /invalid YAML/],
    ["duplicate keys", "toolkit: 1.0.0\ntoolkit: 1.0.0\n", /invalid YAML/],
    ["an empty file", "", /must be a mapping/],
    ["a list", "- toolkit\n", /must be a mapping/],
    ["an unknown key", "toolkit: 1.0.0\ntargets: [claude]\nversion: 1\n", /unknown keys: version/],
    ["a missing pin", "targets: [claude]\n", /toolkit must be an exact/],
    ["a numeric pin", "toolkit: 1.0\ntargets: [claude]\n", /toolkit must be an exact/],
    ["a prefixed pin", "toolkit: v1.0.0\ntargets: [claude]\n", /toolkit must be an exact/],
    ["a range pin", "toolkit: ^1.0.0\ntargets: [claude]\n", /toolkit must be an exact/],
    ["missing targets", "toolkit: 1.0.0\n", /targets must be a non-empty list/],
    ["empty targets", "toolkit: 1.0.0\ntargets: []\n", /targets must be a non-empty list/],
    ["an unknown target", "toolkit: 1.0.0\ntargets: [vscode]\n", /targets must be a non-empty list/],
    ["duplicate targets", "toolkit: 1.0.0\ntargets: [claude, claude]\n", /targets has duplicate entries/],
    ["rules as a list", "toolkit: 1.0.0\ntargets: [claude]\nrules: [committing]\n", /rules must be a mapping/],
    ["a scalar rule entry", "toolkit: 1.0.0\ntargets: [claude]\nrules:\n  a: yes\n", /rules\.a must be empty/],
    [
      "an unknown rule setting",
      "toolkit: 1.0.0\ntargets: [claude]\nrules:\n  a:\n    append: x\n",
      /rules\.a: unknown keys: append/,
    ],
    [
      "an empty description",
      "toolkit: 1.0.0\ntargets: [claude]\nrules:\n  a:\n    description: ''\n",
      /rules\.a\.description must be a non-empty string/,
    ],
    [
      "a parent path",
      "toolkit: 1.0.0\ntargets: [claude]\nrules:\n  a:\n    paths: [../x]\n",
      /rules\.a\.paths must be a list/,
    ],
    [
      "duplicate paths",
      "toolkit: 1.0.0\ntargets: [claude]\nrules:\n  a:\n    paths: [x, x]\n",
      /rules\.a\.paths has duplicate entries/,
    ],
    ["skills as a mapping", "toolkit: 1.0.0\ntargets: [claude]\nskills:\n  sliced:\n", /skills must be a list/],
    ["a non-string skill", "toolkit: 1.0.0\ntargets: [claude]\nskills: [1]\n", /skills must be a list/],
    ["duplicate skills", "toolkit: 1.0.0\ntargets: [claude]\nskills: [a, a]\n", /skills has duplicate entries/],
  ])("rejects %s", (_case, text, message) => {
    expectError(() => parseConfig(text), ConfigError, message);
  });
});

describe("readConfig", () => {
  it("reads agent-toolkit.yaml from the root", () => {
    const root = makeTree({ "agent-toolkit.yaml": CONFIG });

    expect(readConfig(root).toolkit).toBe("1.2.0");
  });

  it("tells the user to run init when the config is missing", () => {
    const root = makeTree({});

    expectError(() => readConfig(root), ConfigError, /no agent-toolkit\.yaml .*run agent-toolkit init/);
  });
});

describe("readLocal", () => {
  it("reads repo-only rules, skills, and extensions", () => {
    const root = makeTree({
      ".agent-toolkit/rules/wikidata-api-safety.md": LOCAL_RULE,
      ".agent-toolkit/skills/qa-sandbox/SKILL.md": SKILL,
      ".agent-toolkit/extensions/documentation-drift.md": "\nAlso audit docs/.\n",
      ".agent-toolkit/.DS_Store": "x",
    });

    const local = readLocal(root);

    expect(local.rules.get("wikidata-api-safety")?.body).toBe("Throttle requests.");
    expect([...local.skills.keys()]).toEqual(["qa-sandbox"]);
    expect(local.extensions).toEqual(new Map([["documentation-drift", "Also audit docs/."]]));
  });

  it("is empty when .agent-toolkit is absent", () => {
    expect(readLocal(makeTree({}))).toEqual(NO_LOCAL);
  });

  it.each([
    ["a misspelled directory", { ".agent-toolkit/rule/a.md": LOCAL_RULE }, ConfigError, /unexpected entries rule/],
    [
      "an invalid local rule",
      { ".agent-toolkit/rules/a.md": "no frontmatter" },
      ContentError,
      /^\.agent-toolkit\/rules\/a\.md: must start/,
    ],
    ["a nested extension", { ".agent-toolkit/extensions/x/a.md": "x" }, ContentError, /extensions must be \.md/],
    ["a file named .agent-toolkit", { ".agent-toolkit": "x" }, ContentError, /\.agent-toolkit: must be a directory/],
    ["a file named rules", { ".agent-toolkit/rules": "x" }, ContentError, /rules: must be a directory/],
    [
      "a skill whose SKILL.md names another skill",
      { ".agent-toolkit/skills/qa/SKILL.md": "---\nname: other\ndescription: Run QA\n---\n" },
      ContentError,
      /^\.agent-toolkit\/skills\/qa\/SKILL\.md: frontmatter name must be qa$/,
    ],
    [
      "an empty extension",
      { ".agent-toolkit/extensions/committing.md": " \n" },
      ContentError,
      /^\.agent-toolkit\/extensions\/committing\.md: is empty$/,
    ],
  ])("rejects %s", (_case, files, type, message) => {
    const root = makeTree(files);

    expectError(() => readLocal(root), type, message);
  });
});

describe("resolveConfig", () => {
  it("applies settings and extensions, adds local items, and collects cited references", () => {
    const local: LocalSources = {
      rules: new Map([["wikidata", rule("wikidata", { references: ["neo4j/ops.md"] })]]),
      skills: new Map([["qa-sandbox", skill("qa-sandbox")]]),
      extensions: new Map([["committing", "Also sign off."]]),
    };
    const repo = config({
      targets: ["claude", "codex"],
      rules: new Map([
        ["committing", {}],
        ["ansible-design", { description: "Infra changes", paths: ["infra/**"] }],
      ]),
      skills: ["sliced"],
    });

    const resolved = resolveConfig(repo, LIBRARY, local);

    expect(resolved.targets).toEqual(["claude", "codex"]);
    expect(resolved.rules).toEqual([
      { name: "ansible-design", description: "Infra changes", paths: ["infra/**"], body: "ansible-design body" },
      {
        name: "committing",
        description: "committing description",
        paths: [],
        body: "committing body\n\nAlso sign off.",
      },
      { name: "wikidata", description: "wikidata description", paths: [], body: "wikidata body" },
    ]);
    expect(resolved.skills.map((item) => item.name)).toEqual(["qa-sandbox", "sliced"]);
    expect(resolved.references.map((item) => item.id)).toEqual(["ansible/gpa.md", "neo4j/ops.md"]);
  });

  it("keeps library settings the config does not replace", () => {
    const resolved = resolveConfig(config({ rules: new Map([["ansible-design", {}]]) }), LIBRARY, NO_LOCAL);

    expect(resolved.rules[0]).toMatchObject({ description: "ansible-design description", paths: ["ansible/**"] });
  });

  it("includes each cited reference once", () => {
    const repo = config({
      rules: new Map([
        ["ansible-design", {}],
        ["neo4j", {}],
      ]),
    });

    expect(resolveConfig(repo, LIBRARY, NO_LOCAL).references.map((item) => item.id)).toEqual([
      "ansible/gpa.md",
      "neo4j/ops.md",
    ]);
  });

  it("resolves an empty config to nothing", () => {
    const resolved = resolveConfig(config(), LIBRARY, NO_LOCAL);

    expect([resolved.rules, resolved.skills, resolved.references]).toEqual([[], [], []]);
  });

  it.each([
    ["an unknown library rule", config({ rules: new Map([["nope", {}]]) }), NO_LOCAL, /nope is not a library rule/],
    ["an unknown library skill", config({ skills: ["nope"] }), NO_LOCAL, /nope is not a library skill/],
    [
      "a local rule named like a library rule",
      config(),
      { ...NO_LOCAL, rules: new Map([["committing", rule("committing")]]) },
      /\.agent-toolkit\/rules: committing shares a library rule name/,
    ],
    [
      "a local skill named like a library skill",
      config(),
      { ...NO_LOCAL, skills: new Map([["sliced", skill("sliced")]]) },
      /\.agent-toolkit\/skills: sliced shares a library skill name/,
    ],
    [
      "an extension of a library rule that is not enabled",
      config(),
      { ...NO_LOCAL, extensions: new Map([["committing", "x"]]) },
      /extensions\/committing\.md: no enabled library rule committing/,
    ],
    [
      "an extension of a local rule",
      config(),
      { ...NO_LOCAL, rules: new Map([["local", rule("local")]]), extensions: new Map([["local", "x"]]) },
      /extensions\/local\.md: no enabled library rule local/,
    ],
    [
      "a local rule citing a reference the library lacks",
      config(),
      { ...NO_LOCAL, rules: new Map([["local", rule("local", { references: ["missing.md"] })]]) },
      /^\.agent-toolkit\/rules\/local\.md: cites reference missing\.md/,
    ],
  ])("rejects %s", (_case, repo, local, message) => {
    expectError(() => resolveConfig(repo, LIBRARY, local), ConfigError, message);
  });
});

describe("comparePin", () => {
  it.each([
    ["1.2.3", "1.2.3", "match"],
    ["1.9.0", "1.10.0", "behind"],
    ["1.2.3", "1.2.10", "behind"],
    ["0.9.9", "1.0.0", "behind"],
    ["2.0.0", "1.99.99", "ahead"],
    ["1.10.0", "1.9.0", "ahead"],
  ])("compares pin %s with installed %s as %s", (pinned, installed, status) => {
    expect(comparePin(pinned, installed)).toBe(status);
  });

  it.each([
    ["1.0", "1.0.0"],
    ["1.0.0", "v1.0.0"],
  ])("rejects %s against %s", (pinned, installed) => {
    expect(() => comparePin(pinned, installed)).toThrow(/not a MAJOR\.MINOR\.PATCH version/);
  });
});

describe("setPin", () => {
  it("changes only the pin, keeping comments and formatting", () => {
    const text = '# Header\ntoolkit: "1.0.0" # pinned\ntargets: [claude, cursor]\n\nrules:\n  # committing:\n';

    expect(setPin(text, "1.2.0")).toBe(text.replace('"1.0.0"', "1.2.0"));
  });

  it.each([
    ["a config with no pin", "targets: [claude]\n", ConfigError, /toolkit must be set/],
    ["invalid YAML", "toolkit: [\n", ConfigError, /invalid YAML/],
  ])("rejects %s", (_case, text, type, message) => {
    expectError(() => setPin(text, "1.2.0"), type, message);
  });

  it("rejects a version that is not exact", () => {
    expect(() => setPin(CONFIG, "^1.2.0")).toThrow(/not a MAJOR\.MINOR\.PATCH version/);
  });
});

describe("starterConfig", () => {
  it("pins the given version for every target and enables the toolkit's own rule and skill", () => {
    expect(parseConfig(starterConfig("1.4.2"))).toEqual({
      toolkit: "1.4.2",
      targets: ["claude", "cursor", "codex"],
      rules: new Map([["agent-toolkit", {}]]),
      skills: ["agent-toolkit-authoring"],
    });
  });

  it("enables only items the bundled library has", () => {
    const resolved = resolveConfig(parseConfig(starterConfig("1.4.2")), loadLibrary(), NO_LOCAL);

    expect(resolved.rules.map((item) => item.name)).toEqual(["agent-toolkit"]);
    expect(resolved.skills.map((item) => item.name)).toEqual(["agent-toolkit-authoring"]);
  });
});

describe("documented examples", () => {
  /** Every `yaml` fence in these documents is a complete `agent-toolkit.yaml`; file formats use other fences. */
  const examples = ["../README.md", "../docs/configuration.md"].flatMap((doc) =>
    Array.from(readFileSync(new URL(doc, import.meta.url), "utf8").matchAll(/```yaml\n([\s\S]*?)```/g), (match) => [
      doc,
      match[1] ?? "",
    ]),
  );

  it("finds config examples to check", () => {
    expect(examples.length).toBeGreaterThanOrEqual(2);
  });

  it.each(examples)("parses the config example in %s", (_doc, text) => {
    expect(() => parseConfig(text)).not.toThrow();
  });
});
