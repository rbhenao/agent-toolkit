---
name: documentation-drift
description: >-
  Audit and fix documentation that no longer matches the repository. Use when the user asks to fix doc drift, audit
  documentation, or says docs are stale, outdated, or out of date with the code.
---

# Documentation Drift

Apply only when the user asks for a documentation audit.

## Surfaces to audit

- `README.md` files at any depth (`rg --files -g README.md`), `AGENTS.md`, `CLAUDE.md`, and their per-package
  variants.
- `docs/` and any other directory the repository uses for current documentation.
- Every additional surface `AGENTS.md` names, such as operator quick references or fixture manifests.
- Agent guidance sources, for the paths, module names, and commands they cite. Where agent-toolkit generates the
  guidance, audit the sources under `.agent-toolkit/` and `agent-toolkit.yaml`, never the generated files.

Out of scope: design records, plans, decision logs, and product direction. They record decisions rather than describe
the current code. Never edit vendored or extracted reference material.

## What counts as drift

- Commands that no longer work as written: renamed scripts or tasks, changed package-manager invocations, or stale
  environment variable names. Verify them against the task runner and the package manifest.
- Paths, modules, or files that no longer exist or have moved. Verify cited paths with `rg --files` or direct reads.
- Layouts, pipeline descriptions, or architecture claims that no longer match the code.
- Features described as planned that now exist, or described as existing that were removed.
- Indexes and manifests, such as fixture lists or reference catalogs, that no longer match the files present.

## What is not drift

Docs describing future work that is not built yet. Do not rewrite a proposal as if it were implemented; flag only
claims that are factually wrong about the current repository.

## Procedure

1. Inventory the surfaces above. Do not start from memory or from whichever files happen to be open.
2. Verify every concrete claim against the repository before calling it drift.
3. Present findings grouped by file: the stale claim, then the current reality.
4. Fix unambiguous drift in place. List judgment calls and ask before changing them.
5. Keep edits minimal: correct the stale claim; do not restructure or expand documents.
6. Do not commit unless the user asks.
