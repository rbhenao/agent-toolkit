---
name: agent-toolkit-authoring
description: >-
  Add, change, or remove a repository's agent rules, skills, or rule extensions with agent-toolkit. Use when the user
  asks to add or edit agent guidance, a rule, a skill, or a guideline, or to customize a library rule, in a
  repository that has an agent-toolkit.yaml.
---

# Agent Toolkit Authoring

## Choose the change

1. Run `agent-toolkit list`. If a library rule or skill already covers the need, enable it in `agent-toolkit.yaml`
   rather than writing a new one.
2. Pick the smallest change that fits:
   - A library rule fits but its scope or description does not: set `paths` or `description` under it in the config.
     `paths: []` makes it always apply.
   - A library rule fits but needs repository specifics: add an extension.
   - Nothing fits: add a repo-only rule or skill. A rule is guidance that applies while working on matching files, or
     always. A skill is a procedure invoked for a task.
3. Never edit a generated file. Every path listed in `.agents/toolkit.lock` is generated.

## Enable library content

```yaml
rules:
  committing:
  ansible-design:
    paths: [infra/**/*.yml]
skills:
  - documentation-drift
```

A bare `name:` enables a rule unchanged. Settings replace the library's values. Skills have no settings.

## Repo-only rule

Write `.agent-toolkit/rules/<name>.md`:

```markdown
---
description: When the rule applies, such as "Preserve polite API behavior when changing request rates"
paths:
  - src/clients/**/*.py
---

# Rule Title

The guidance.
```

- `description` is required. Say when the rule applies, not what it contains; it is what a tool reads first.
- `paths` is optional. Without it the rule always applies.
- To use a library reference, list its id under `references` and cite it in the body by its `.agents/references/<id>`
  path. Each listed id must be cited, and each cited path listed. `agent-toolkit list` shows the reference ids.

## Repo-only skill

Write `.agent-toolkit/skills/<name>/SKILL.md`, plus any supporting files beside it:

```markdown
---
name: <name>
description: What the skill does, then "Use when ..." with the requests that should trigger it.
---

# Skill Title

The procedure.
```

`name` must equal the directory name and stay within 64 characters; `description` stays within 1,024.

## Extension

Write `.agent-toolkit/extensions/<name>.md` to append text to the enabled library rule `<name>`. It has no
frontmatter and cannot cite references. Start it with its own heading, such as `## Project specifics`, because it
lands after the rule's last section.

## Requirements for all of them

- Names are kebab-case and must not match any library rule or skill name. To diverge from a library rule, write a
  repo-only rule under a new name and stop enabling the library one.
- Every tool reads the same text, so it must not name a tool's own directory. Cite generated paths under `.agents/`.
- Files are UTF-8 with LF line endings; symlinks are rejected.

## Verify

1. Run `agent-toolkit check`. Fix every error it reports; each one names the file and the problem. Before the first
   sync, `check` lists the new generated paths as missing, which is expected.
2. Run `agent-toolkit sync`, then `agent-toolkit check` again, which should report that generated files match.
3. Report the source and generated files that changed. Do not commit unless the user asks.

To remove something, delete its file or its config entry and sync; the toolkit deletes the generated files it no
longer needs.
