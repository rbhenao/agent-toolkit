# agent-toolkit

Generate agent rules, skills, and references for Claude Code, Cursor, and Codex from one config file.

A repository lists what it wants from a shared, versioned library in `agent-toolkit.yaml`, adds its own content under
`.agent-toolkit/`, and the toolkit writes the files each tool reads natively. Generated files are committed, and
`agent-toolkit check` keeps them in step with the config in CI.

## Install

Requires Node 24 or later on macOS or Linux.

```bash
npm install -g @rbhenao/agent-toolkit
```

The package is not published yet. Until it is, build and link it from a clone:

```bash
npm install && npm run build && npm link
```

## Quick start

```bash
cd your-repo
agent-toolkit init    # write a starter agent-toolkit.yaml pinned to the installed version, then sync
agent-toolkit list    # see the library's rules, skills, and references
# enable what you want in agent-toolkit.yaml
agent-toolkit sync    # write the generated files, then commit them
```

## Commands

| Command   | What it does                                                                   |
| --------- | ------------------------------------------------------------------------------ |
| `init`    | Write a starter config pinned to the installed version, then sync.             |
| `sync`    | Write the files the config resolves to.                                        |
| `check`   | Report differences without writing; exits 1 when generated files have drifted. |
| `upgrade` | Move the pin to the installed version and sync.                                |
| `list`    | Show the library and mark what the repo enables.                               |

Exit codes are 0 for success, 1 for drift found by `check`, and 2 for any error.

## Configuration

`agent-toolkit.yaml` holds structure only; all rule and skill text lives in files.

```yaml
toolkit: 0.1.0 # exact toolkit version the generated files are built from
targets: [claude, cursor, codex]
rules:
  committing:
  ai-manifesto-python:
  ansible-design:
    paths: [infra/**/*.yml] # optional settings replace the library defaults
skills:
  - sliced-implementation
```

Repo-specific content is found by location:

```text
.agent-toolkit/
  rules/<name>.md          a repo-only rule
  skills/<name>/SKILL.md   a repo-only skill
  extensions/<name>.md     text appended to the enabled library rule <name>
```

A repo-only rule or skill must not reuse a library name. [`docs/configuration.md`](docs/configuration.md) lists
every option, its allowed values, and the file formats under `.agent-toolkit/`.

## What gets generated

- `.agents/` is tool-neutral and always written: a copy of every rule, every skill, and the references the rules cite.
- Claude Code and Cursor get rule files in their own format, plus links to the shared skills.
- Codex reads skills from `.agents/skills/` directly.
- `.agents/toolkit.lock` records every path the toolkit owns. It only ever changes or removes those paths, and refuses
  to overwrite anything else.

Never edit generated files; change the config or `.agent-toolkit/` and run `sync`.

## Versioning

The config pins an exact toolkit version, and `sync` and `check` refuse to run under a different one. `upgrade` moves
the pin to the installed version; review its diff like a dependency bump. CI can run the pinned version without a
global install:

```bash
npx @rbhenao/agent-toolkit@<pinned-version> check
```

## Library

The library ships with the package under `library/`: general rules (including a design manifesto per language),
skills for common workflows, and references with recorded provenance. `agent-toolkit list` shows the current contents.

## Development

[`AGENTS.md`](AGENTS.md) is the project contract for contributors and coding agents: stack, layout, and verification
commands. [`AI_MANIFESTO.md`](AI_MANIFESTO.md) holds the design principles. Each module in `src/` opens with an
overview of its design.

## License

[MIT](LICENSE)
