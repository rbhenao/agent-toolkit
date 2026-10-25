import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { Plan } from "../src/render.js";
import { applyPlan, ConflictError, diffPlan, type Drift, LOCK_FILE, LockError, readLock } from "../src/write.js";

const PLAN: Plan = [
  { kind: "file", path: ".agents/rules/committing.md", content: "rule\n" },
  { kind: "file", path: ".agents/skills/sliced/SKILL.md", content: "skill\n" },
  { kind: "link", path: ".claude/skills/sliced", target: "../../.agents/skills/sliced" },
];

const NO_DRIFT: Drift = { stale: [], missing: [], orphaned: [], conflicts: [] };

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

/** Return a repo synced to `PLAN`. */
function syncedRepo(): string {
  const root = makeTree();
  applyPlan(root, PLAN, undefined);
  return root;
}

function read(root: string, path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("readLock", () => {
  it("returns undefined for a repo that was never synced", () => {
    expect(readLock(makeTree())).toBeUndefined();
  });

  it("reads the owned paths", () => {
    const root = makeTree({ [LOCK_FILE]: '{"paths": [".agents/rules/a.md", ".claude/skills/s"]}' });

    expect(readLock(root)).toEqual({ paths: [".agents/rules/a.md", ".claude/skills/s"] });
  });

  it.each([
    ["invalid JSON", "{", /invalid JSON/],
    ["a list", "[]", /must be \{"paths"/],
    ["an extra key", '{"paths": [], "version": "1.0.0"}', /must be \{"paths"/],
    ["a path outside the output directories", '{"paths": ["src/index.ts"]}', /must be \{"paths"/],
    ["an output directory prefix without a separator", '{"paths": [".agents-x/a.md"]}', /must be \{"paths"/],
    ["an escaping path", '{"paths": [".agents/../src/index.ts"]}', /must be \{"paths"/],
    ["an unnormalized path", '{"paths": [".agents/./a.md"]}', /must be \{"paths"/],
    ["an absolute path", '{"paths": ["/etc/passwd"]}', /must be \{"paths"/],
    ["duplicate paths", '{"paths": [".agents/a.md", ".agents/a.md"]}', /duplicate entries/],
  ])("rejects %s", (_case, text, message) => {
    const root = makeTree({ [LOCK_FILE]: text });

    expect(() => readLock(root)).toThrow(LockError);
    expect(() => readLock(root)).toThrow(message);
  });
});

describe("diffPlan", () => {
  it("reports every entry and the lock as missing in a fresh repo", () => {
    expect(diffPlan(makeTree(), PLAN, undefined)).toEqual({
      ...NO_DRIFT,
      missing: [...PLAN.map((entry) => entry.path), LOCK_FILE],
    });
  });

  it("reports no drift right after a sync", () => {
    const root = syncedRepo();

    expect(diffPlan(root, PLAN, readLock(root))).toEqual(NO_DRIFT);
  });

  it.each([
    [
      "a hand-edited file",
      ".agents/rules/committing.md",
      (root: string) => {
        put(root, ".agents/rules/committing.md", "edited\n");
      },
    ],
    [
      "a retargeted link",
      ".claude/skills/sliced",
      (root: string) => {
        unlinkSync(join(root, ".claude/skills/sliced"));
        symlinkSync("../../elsewhere", join(root, ".claude/skills/sliced"));
      },
    ],
    [
      "a file replaced by a link",
      ".agents/rules/committing.md",
      (root: string) => {
        unlinkSync(join(root, ".agents/rules/committing.md"));
        symlinkSync("other.md", join(root, ".agents/rules/committing.md"));
      },
    ],
  ])("reports %s as stale", (_case, path, change) => {
    const root = syncedRepo();
    const lock = readLock(root);
    change(root);

    expect(diffPlan(root, PLAN, lock)).toEqual({ ...NO_DRIFT, stale: [path] });
  });

  it("reports a deleted owned file as missing", () => {
    const root = syncedRepo();
    unlinkSync(join(root, ".agents/rules/committing.md"));

    expect(diffPlan(root, PLAN, readLock(root))).toEqual({ ...NO_DRIFT, missing: [".agents/rules/committing.md"] });
  });

  it("reports an unowned file with different content as a conflict", () => {
    const root = makeTree({ ".agents/rules/committing.md": "mine\n" });

    expect(diffPlan(root, PLAN, undefined).conflicts).toEqual([".agents/rules/committing.md"]);
  });

  it("treats an unowned file that already matches the plan as current", () => {
    const root = makeTree({ ".agents/rules/committing.md": "rule\n" });

    expect(diffPlan(root, PLAN, undefined)).toMatchObject({ stale: [], conflicts: [] });
    expect(diffPlan(root, PLAN, undefined).missing).not.toContain(".agents/rules/committing.md");
  });

  it("reports a directory at a planned path as a conflict even when owned", () => {
    const root = syncedRepo();
    const lock = readLock(root);
    unlinkSync(join(root, ".claude/skills/sliced"));
    mkdirSync(join(root, ".claude/skills/sliced"));

    expect(diffPlan(root, PLAN, lock).conflicts).toEqual([".claude/skills/sliced"]);
  });

  it("reports a path below a symlinked directory as a conflict", () => {
    const root = makeTree();
    const outside = makeTree();
    mkdirSync(join(root, ".claude"));
    symlinkSync(outside, join(root, ".claude/skills"));

    expect(diffPlan(root, PLAN, undefined).conflicts).toEqual([".claude/skills/sliced"]);
  });

  it("reports owned files and links the plan dropped as orphaned", () => {
    const root = syncedRepo();

    expect(diffPlan(root, PLAN.slice(0, 1), readLock(root)).orphaned).toEqual([
      ".agents/skills/sliced/SKILL.md",
      ".claude/skills/sliced",
    ]);
  });

  it("ignores dropped owned paths that are gone or are now directories", () => {
    const root = syncedRepo();
    const lock = readLock(root);
    unlinkSync(join(root, ".claude/skills/sliced"));
    mkdirSync(join(root, ".claude/skills/sliced"));
    rmSync(join(root, ".agents/skills"), { recursive: true });

    expect(diffPlan(root, PLAN.slice(0, 1), lock).orphaned).toEqual([]);
  });
});

describe("applyPlan", () => {
  it("writes files, links, and a lock that lists every owned path including itself", () => {
    const root = makeTree();

    const applied = applyPlan(root, PLAN, undefined);

    expect(applied.missing).toHaveLength(PLAN.length + 1);
    expect(read(root, ".agents/rules/committing.md")).toBe("rule\n");
    expect(readlinkSync(join(root, ".claude/skills/sliced"))).toBe("../../.agents/skills/sliced");
    expect(read(root, ".claude/skills/sliced/SKILL.md")).toBe("skill\n");
    expect(readLock(root)?.paths).toEqual([
      ".agents/rules/committing.md",
      ".agents/skills/sliced/SKILL.md",
      LOCK_FILE,
      ".claude/skills/sliced",
    ]);
  });

  it("does nothing on a second run", () => {
    const root = syncedRepo();

    expect(applyPlan(root, PLAN, readLock(root))).toEqual(NO_DRIFT);
  });

  it("overwrites hand edits and replaces retargeted links", () => {
    const root = syncedRepo();
    const lock = readLock(root);
    put(root, ".agents/rules/committing.md", "edited\n");
    unlinkSync(join(root, ".claude/skills/sliced"));
    symlinkSync("../../elsewhere", join(root, ".claude/skills/sliced"));

    applyPlan(root, PLAN, lock);

    expect(read(root, ".agents/rules/committing.md")).toBe("rule\n");
    expect(readlinkSync(join(root, ".claude/skills/sliced"))).toBe("../../.agents/skills/sliced");
  });

  it("replaces a link at a file path without writing through it", () => {
    const root = syncedRepo();
    const lock = readLock(root);
    put(root, "target.md", "untouched\n");
    unlinkSync(join(root, ".agents/rules/committing.md"));
    symlinkSync("../../target.md", join(root, ".agents/rules/committing.md"));

    applyPlan(root, PLAN, lock);

    expect(lstatSync(join(root, ".agents/rules/committing.md")).isFile()).toBe(true);
    expect(read(root, "target.md")).toBe("untouched\n");
  });

  it("removes orphans and the directories they leave empty, keeping non-empty ones", () => {
    const root = syncedRepo();
    put(root, ".claude/settings.json", "{}");

    applyPlan(root, PLAN.slice(0, 1), readLock(root));

    expect(existsSync(join(root, ".agents/skills"))).toBe(false);
    expect(existsSync(join(root, ".claude/skills"))).toBe(false);
    expect(readdirSync(join(root, ".claude"))).toEqual(["settings.json"]);
    expect(readLock(root)?.paths).toEqual([".agents/rules/committing.md", LOCK_FILE]);
  });

  it("refuses to run when anything conflicts, writing nothing", () => {
    const root = makeTree({ ".agents/rules/committing.md": "mine\n" });

    expect(() => applyPlan(root, PLAN, undefined)).toThrow(ConflictError);
    expect(() => applyPlan(root, PLAN, undefined)).toThrow(/\.agents\/rules\/committing\.md; move or delete them/);
    expect(read(root, ".agents/rules/committing.md")).toBe("mine\n");
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("never writes through a symlinked directory", () => {
    const root = makeTree();
    const outside = makeTree();
    mkdirSync(join(root, ".claude"));
    symlinkSync(outside, join(root, ".claude/skills"));

    expect(() => applyPlan(root, PLAN, undefined)).toThrow(ConflictError);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("adopts unowned files that already match, so an interrupted sync can finish", () => {
    const root = makeTree({ ".agents/rules/committing.md": "rule\n" });

    applyPlan(root, PLAN, undefined);

    expect(readLock(root)?.paths).toContain(".agents/rules/committing.md");
  });

  it.each<[string, Plan, RegExp]>([
    ["a path escaping the repo", [{ kind: "file", path: "../outside.txt", content: "x" }], /may not write: \.\.\//],
    ["a path outside the output directories", [{ kind: "file", path: "src/a.ts", content: "x" }], /may not write/],
    ["an unnormalized path", [{ kind: "file", path: ".agents/./a.md", content: "x" }], /may not write/],
    ["the lock itself", [{ kind: "file", path: LOCK_FILE, content: "x" }], /may not write/],
    ["a duplicate path", [PLAN[0], PLAN[0]].flatMap((entry) => entry ?? []), /duplicate paths/],
  ])("rejects a plan with %s before touching disk", (_case, plan, message) => {
    const root = makeTree();

    expect(() => applyPlan(root, plan, undefined)).toThrow(message);
    expect(readdirSync(root)).toEqual([]);
    expect(existsSync(join(root, "..", "outside.txt"))).toBe(false);
  });
});
