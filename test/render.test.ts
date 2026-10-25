import { readFileSync } from "node:fs";
import { posix } from "node:path";

import { describe, expect, it } from "vitest";

import type { ResolvedConfig, ResolvedRule } from "../src/config.js";
import { REFERENCE_PREFIX } from "../src/library.js";
import { AGENTS_DIR, render, renderRule, type RuleFormat, SKILLS_DIR } from "../src/render.js";

const SCOPED: ResolvedRule = {
  name: "ansible-design",
  description: "Keep Ansible roles small: one purpose per role",
  paths: ["ansible/**/*.yml", "**/*.j2"],
  body: [
    "# Ansible Design",
    "",
    "Read `.agents/references/ansible/gpa.md` before changing roles.",
    "",
    "- Keep shared inputs shared.",
  ].join("\n"),
};

const ALWAYS: ResolvedRule = {
  name: "committing",
  description: "Commit only when the user asks",
  paths: [],
  body: "# Committing\n\nStage only this session's files.",
};

const RESOLVED: ResolvedConfig = {
  targets: ["claude", "cursor", "codex"],
  rules: [SCOPED, ALWAYS],
  skills: [
    {
      name: "sliced",
      files: new Map([
        ["SKILL.md", "sliced skill"],
        ["notes/checklist.md", "checklist"],
      ]),
    },
  ],
  references: [{ id: "ansible/gpa.md", content: "gpa" }],
};

function fixture(name: string): string {
  return readFileSync(new URL(`fixtures/render/${name}`, import.meta.url), "utf8");
}

describe("renderRule", () => {
  it.each<[ResolvedRule, RuleFormat, string]>([
    [SCOPED, "agents", "scoped.agents.md"],
    [SCOPED, "claude", "scoped.claude.md"],
    [SCOPED, "cursor", "scoped.cursor.mdc"],
    [ALWAYS, "agents", "always.agents.md"],
    [ALWAYS, "claude", "always.claude.md"],
    [ALWAYS, "cursor", "always.cursor.mdc"],
  ])("renders %s in the %s format", (rule, format, name) => {
    expect(renderRule(rule, format)).toBe(fixture(name));
  });
});

describe("render", () => {
  it("plans neutral copies, tool rules, skill files and links, and references, sorted by path", () => {
    const plan = render(RESOLVED);

    expect(plan.map((entry) => [entry.kind, entry.path])).toEqual([
      ["file", ".agents/references/ansible/gpa.md"],
      ["file", ".agents/rules/ansible-design.md"],
      ["file", ".agents/rules/committing.md"],
      ["file", ".agents/skills/sliced/SKILL.md"],
      ["file", ".agents/skills/sliced/notes/checklist.md"],
      ["file", ".claude/rules/ansible-design.md"],
      ["file", ".claude/rules/committing.md"],
      ["link", ".claude/skills/sliced"],
      ["file", ".cursor/rules/ansible-design.mdc"],
      ["file", ".cursor/rules/committing.mdc"],
      ["link", ".cursor/skills/sliced"],
    ]);
  });

  it("renders each rule file in its directory's format and copies skills and references unchanged", () => {
    const contents = new Map(
      render(RESOLVED).flatMap((entry) => (entry.kind === "file" ? [[entry.path, entry.content]] : [])),
    );

    expect(contents.get(".agents/rules/committing.md")).toBe(renderRule(ALWAYS, "agents"));
    expect(contents.get(".claude/rules/ansible-design.md")).toBe(renderRule(SCOPED, "claude"));
    expect(contents.get(".cursor/rules/ansible-design.mdc")).toBe(renderRule(SCOPED, "cursor"));
    expect(contents.get(".agents/skills/sliced/notes/checklist.md")).toBe("checklist");
    expect(contents.get(".agents/references/ansible/gpa.md")).toBe("gpa");
  });

  it("links each tool skill directory to the shared skill with a relative target", () => {
    const links = render(RESOLVED).flatMap((entry) => (entry.kind === "link" ? [entry] : []));

    expect(links.map((entry) => entry.target)).toEqual(["../../.agents/skills/sliced", "../../.agents/skills/sliced"]);
    for (const entry of links) {
      expect(posix.join(posix.dirname(entry.path), entry.target)).toBe(`${SKILLS_DIR}/sliced`);
    }
  });

  it("writes only the shared .agents/ files for codex", () => {
    const plan = render({ ...RESOLVED, targets: ["codex"] });

    expect(plan.every((entry) => entry.path.startsWith(`${AGENTS_DIR}/`))).toBe(true);
    expect(plan.map((entry) => entry.path)).toContain(".agents/rules/committing.md");
    expect(plan.map((entry) => entry.path)).toContain(".agents/skills/sliced/SKILL.md");
  });

  it("plans nothing for an empty resolution", () => {
    expect(render({ targets: ["claude"], rules: [], skills: [], references: [] })).toEqual([]);
  });

  it("writes references where rule bodies cite them", () => {
    expect(REFERENCE_PREFIX.startsWith(`${AGENTS_DIR}/`)).toBe(true);
  });
});
