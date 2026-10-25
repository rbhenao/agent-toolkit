# Configuration Reference

A repository configures agent-toolkit in two places:

- `agent-toolkit.yaml` at the repository root says which library content to use and for which tools. It holds
  structure only.
- `.agent-toolkit/` holds the repository's own rules, skills, and extensions to library rules, as files.

Run `agent-toolkit list` to see the library's rule, skill, and reference names. `sync` and `check` validate everything
here before writing anything, and each error names the file at fault.

`agent-toolkit init` starts the config with the library's `agent-toolkit` rule, which keeps agents from editing
generated files, and its `agent-toolkit-authoring` skill, which lets coding agents write the files described here.

## agent-toolkit.yaml

A complete example:

```yaml
toolkit: 0.1.0
targets: [claude, cursor, codex]
rules:
  committing:
  ai-manifesto-python:
  ansible-design:
    paths:
      - infra/**/*.yml
      - infra/**/*.j2
  multi-agent-workflow:
    description: When editing plans or notes under design/ or planning/
    paths: [design/**/*.md, planning/**/*.md]
skills:
  - documentation-drift
  - sliced-implementation
```

The file must be a YAML mapping. Unknown keys and duplicate keys are errors, at the top level and inside rule
settings.

### `toolkit`

- **Type:** string, required.
- **Allowed values:** an exact `MAJOR.MINOR.PATCH` version such as `1.4.0`. Ranges (`^1.4.0`), prefixes (`v1.4.0`),
  pre-release tags (`1.4.0-beta.1`), and leading zeros (`01.4.0`) are rejected.

The pin is the toolkit version the generated files are built from. `sync` and `check` refuse to run when the installed
version differs from it; `upgrade` moves it to the installed version. Write it unquoted or quoted; a two-part value
such as `1.4` is read by YAML as a number and rejected.

### `targets`

- **Type:** list of strings, required, at least one entry, no duplicates.
- **Allowed values:** `claude`, `cursor`, `codex`.

The tools to generate files for. The tool-neutral `.agents/` directory is written whatever the targets are.

### `rules`

- **Type:** mapping of library rule names to settings, optional.
- **Default:** no library rules enabled. An absent or empty `rules:` enables nothing.

Each key enables the library rule of that name. A bare `name:` enables it with the library's settings. Otherwise
the value is a mapping of settings, each of which replaces the library's value:

- **`description`:** non-empty string. What a tool shows before it reads the rule, so it should say when the rule
  applies.
- **`paths`:** list of unique repo-relative glob patterns that trigger the rule. Patterns must not start with `/` or
  contain a `..` segment. An empty list, `paths: []`, makes the rule always apply.

Repo-only rules are not listed here; they are included by existing in `.agent-toolkit/rules/`.

### `skills`

- **Type:** list of library skill names, optional, no duplicates.
- **Default:** no library skills enabled. An absent or empty `skills:` enables nothing.

Skills have no settings. Repo-only skills are not listed here; they are included by existing in
`.agent-toolkit/skills/`.

## .agent-toolkit/

```text
.agent-toolkit/
  rules/<name>.md          a repo-only rule
  skills/<name>/SKILL.md   a repo-only skill, plus any supporting files
  extensions/<name>.md     text appended to the enabled library rule <name>
```

- Everything found here is included; nothing is listed in the config.
- The directory and each of its subdirectories are optional. Any other entry, such as a misspelled `rule/`, is an
  error. `.DS_Store` files, `.gitkeep` files, and `__pycache__` directories are ignored everywhere.
- Names are kebab-case: lowercase letters and digits in hyphen-separated words.
- A repo-only rule or skill must not share a name with any library rule or skill, enabled or not. To diverge from a
  library rule, write a repo-only rule under a new name and stop enabling the library one.
- Files must be regular UTF-8 text. Symlinks are rejected.

### Rules

A rule is a Markdown file directly under `rules/`. Library rules use the same format.

```markdown
---
description: Follow the project's deploy conventions when changing service roles
paths:
  - deploy/roles/**/*.yml
references:
  - ansible/good-practices-for-ansible.md
---

# Deploy Roles

General role design is in `.agents/references/ansible/good-practices-for-ansible.md`. This project adds:

- Every service role exposes its listening port as `service_port`.
```

- The file starts with a `---` line, uses LF line endings, and allows only these frontmatter keys:
  - **`description`:** non-empty string, required. Say when the rule applies, not what it contains.
  - **`paths`:** list of unique repo-relative glob patterns, optional. Without it the rule always applies.
  - **`references`:** list of library reference ids, optional.
- The body after the frontmatter must not be empty.
- Every tool reads the same body, so it must not name a tool's own directory (`.claude/`, `.cursor/`, `.codex/`). Cite
  generated paths under `.agents/` instead.
- Each listed reference must be cited in the body by its full `.agents/references/<id>` path, each cited path must be
  listed, and each id must exist in the library.

### Skills

A skill is a directory under `skills/` whose `SKILL.md` starts with frontmatter:

```markdown
---
name: qa-sandbox
description: Run checks on the QA host through the sandbox account. Use when asked to verify live state on QA.
---

# QA Sandbox
```

- **`name`:** required, must equal the directory name, at most 64 characters.
- **`description`:** non-empty string, required, at most 1,024 characters. Say what the skill does and when to use it.
- Other frontmatter keys, such as a tool's own skill settings, are passed through unchecked.
- Supporting files may sit beside `SKILL.md`, in subdirectories too. Every file is copied unchanged, and none may
  name a tool's own directory. File permissions are not preserved.

### Extensions

An extension is a Markdown file directly under `extensions/` whose text is appended, after a blank line, to the body
of the enabled library rule with the same name.

```markdown
## Project specifics

- Also audit `ops/QUICKREF.txt` and `queries/README.md`.
```

- The library rule must be enabled in `rules`; an extension with nothing to extend is an error.
- No frontmatter: change `description` or `paths` through the config instead.
- The text must not be empty, must not name a tool's own directory, and cannot cite references. Cite them from a
  repo-only rule instead.
- The text lands after the rule's last section, so start it with a heading of its own.

## Generated files

| Path                       | Contents                                               | Written when         |
| -------------------------- | ------------------------------------------------------ | -------------------- |
| `.agents/rules/<name>.md`  | Every rule, with `description` and `paths` frontmatter | Always               |
| `.agents/skills/<name>/`   | Every skill's files                                    | Always               |
| `.agents/references/<id>`  | Each reference an included rule cites                  | Always               |
| `.agents/toolkit.lock`     | Every path the toolkit owns, as JSON                   | Always               |
| `.claude/rules/<name>.md`  | Every rule, with `description` and `paths` frontmatter | `claude` is a target |
| `.claude/skills/<name>`    | Symlink to `.agents/skills/<name>`                     | `claude` is a target |
| `.cursor/rules/<name>.mdc` | Every rule, with `description`, `globs`, `alwaysApply` | `cursor` is a target |
| `.cursor/skills/<name>`    | Symlink to `.agents/skills/<name>`                     | `cursor` is a target |

Codex reads `.agents/skills/` directly. A rule that always applies has no `paths`, or `alwaysApply: true` for Cursor.

The toolkit only changes or removes paths recorded in the lock. When something it does not own is in the way, `sync`
lists the conflicting paths and writes nothing.
