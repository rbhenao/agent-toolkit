---
title: Good Practices for Ansible (digest)
source: https://redhat-cop.github.io/automation-good-practices/
upstream: https://github.com/redhat-cop/automation-good-practices/tree/fb5fcd6f03c544909dbad352a352b421c41d7203
retrieved: 2026-10-22
license: >-
  MIT, as part of agent-toolkit. This is an original summary written for agent-toolkit. The upstream document states
  no license, so none of its text is reproduced here.
---

# Good Practices for Ansible (digest)

This digest condenses the Red Hat Community of Practice guide "Good Practices for Ansible" (GPA). Each entry is the
practice followed by the reason for it. Upstream presents these as _good_ practices, not rules: depart from one when
there is a concrete reason, and say so. Open the source when you need the full examples.

Sections follow upstream order: Foundations, Developing Ansible Content, AAP Configuration as Code, and Lifecycle and
Operations.

## Structures

- Agree as a team on which construct holds what. A workable split is:
  - **landscape**: everything deployed together (a workflow, or a playbook that imports type playbooks);
  - **type**: one per host, deployed by exactly one playbook;
  - **function**: a reusable role that makes up part of a type;
  - **component**: a task file inside a function role, promoted to its own role only once it outgrows that.

  Why: a shared structure is what makes code reusable across people. New types become a reshuffle of existing
  function roles.
- Don't number playbooks that must be run in sequence. Each type should be fully deployed by a single playbook.
- Break the structure deliberately, never by accident. Discuss exceptions openly, for example when external
  collections don't fit it.

## Naming Conventions

- Names should be descriptive, consistent, and short. Use one separator per context (hyphens for repos and files,
  underscores for AAP resources) and one extension (`.yml`, not a mix of `.yml` and `.yaml`). Abbreviate only with
  widely known forms such as `dev`, `prod`, `ee`, `config`.
- Repositories: lowercase `{purpose}-{type}` with hyphens, under 50 characters.
- Playbooks: `{verb}-{noun}.yml`. An optional `pb_` prefix makes it easy for tooling to tell playbooks apart from
  other YAML files.
- Branches: `{type}/{description}`. Commits: conventional commits (`feat:`, `fix:`, `docs:`, ...). Why: this is what
  enables generated changelogs and release automation.
- AAP resources: lowercase with underscores, plus a short organization prefix (`eng_`, `ops_`) so names stay unique.
  Each resource type has its own pattern; for example, job templates are `{org}_{action}_{target}_{scope}`.

## Roles

### Design

- Design roles around the outcome they deliver, not the software that delivers it. For example, a time-sync role
  chooses between chrony and ntpd internally. Split into separate roles only when the implementations diverge too far.
- Give each role one guaranteed outcome and limit its scope to that outcome.
- A collection can expose a single entry-point role that orchestrates the internal ones. Consumers then don't need to
  know role names or ordering, and the internals can change behind a stable interface.
- Put content shared by several roles into one `common` role. Keep coupling loose and the hierarchy explicit, because
  hard dependencies on outside roles or variables make a role brittle.
- Start new roles from a standard skeleton so every role has the same file tree.
- Tag releases with semantic versioning in strict `X.Y.Z` form. Stay on `0.y.z` until the interface is stable. Why:
  Galaxy and Automation Hub require the strict format.
- Prefer distributing roles inside a collection. It provides a namespace, shared plugins, and a single unit of
  distribution.

### Variables and naming

- Prefix every default, argument, module, and tag with the role name (`foo_packages`, not `packages`). Why: Ansible has
  no namespaces, so anything a role defines leaks into the play.
- Prefix internal variables with two underscores (`__foo_tmp`). That includes `register` and `set_fact` results, which
  persist after the role finishes.
- Don't use dashes in role names; they break inside collections.
- Every input from outside the role gets an entry in `defaults/main.yml`, documented there and in the README. Rely on
  that entry instead of the `default()` filter, except for optional dictionary keys.
- If an input has no safe default, list it in `defaults/main.yml` commented out and let the role fail when it is
  missing. Failing is better than guessing wrong.
- Put constants and large static lists in `vars/main.yml`. Don't use it for user-facing defaults: its precedence is so
  high that users can barely override it. Pattern: required packages go in `vars/` as `foo_packages`, and user
  additions go in `foo_extra_packages`, defaulting to `[]`.
- Don't hardcode inventory group names. Take the host list or the group name as a parameter. Why: groups belong to the
  inventory's data, and a fixed group name limits each inventory to one cluster.
- Validate inputs with `meta/argument_specs.yml` (ansible-core 2.11 and later) so a bad call fails at the start
  instead of partway through.

### Platforms and providers

- Don't branch on distribution or version inside tasks. Load layered vars files from `vars/`, least specific first:
  `os_family`, then `distribution`, then `distribution_major_version`, then the full version. Skip any file that
  doesn't exist, so supporting a new platform means adding one file.
- For platform-specific tasks, include only the most specific match: `first_found`, most specific first, falling back
  to a default task file.
- Support missing facts (`gather_facts: false`) by gathering only the subset the role needs. Otherwise document facts
  as required and fail clearly when they are absent.
- When there are several implementations ("providers"), expose `foo_provider`. If it isn't set, keep whatever provider
  is already running, and otherwise pick the OS default. Also publish `foo_provider_os_default`, so users can pin
  systems consistently without choosing a value themselves.
- Use one task file and one vars file per provider, and make sure every supported provider has its files.
- Build include paths from `{{ role_path }}` whenever the filename contains a variable. Why: a relative path can
  resolve to a file in the role that included yours.
- Read facts with brackets: `ansible_facts['distribution']`, not the injected `ansible_distribution`.

### Check mode, idempotency, templates

- Roles must survive check mode without failing and without reporting false changes. If that isn't possible, document
  why.
- A second run with the same inputs must change nothing and report nothing. `command` and `shell` always report a
  change, so set `changed_when`.
- Registered variables are the usual check-mode trap: when the task that registers one is skipped, later tasks break.
  Fetch the data with an idempotent module instead (for example `slurp` rather than `command: cat`), or set
  `check_mode` and `changed_when` explicitly. When a command has a dry-run flag, use it under `ansible_check_mode`.
- Start templates with `{{ ansible_managed | comment }}`. Never write timestamps into managed files; they create a
  change on every run.
- Keep backups on (`backup: true`) until someone asks for them to be configurable. State in the README which files the
  role replaces outright rather than edits.

### Documentation

- Every role has a README in its root covering: purpose, outcome, the unit of automation, inputs and outputs (the
  argument spec), capabilities, rollback behavior, whether it is idempotent and atomic, and example playbooks.
- In examples, use fully qualified role names and documentation-reserved IP ranges (RFC 5737, RFC 3849, RFC 7042).
- Prefix task names in included task files with a short tag for that file (`sub | Do the thing`), so the log shows
  where each task came from.

## Collections

- Group roles into collections at the type or landscape level, not one collection per role. Why: collections are the
  unit of distribution, and this matters even more with execution environments.
- For values shared across the collection, have each role's defaults reference one collection-level variable
  (documented in the collection docs). Roles stay reusable on their own and can still be overridden one at a time.
- Each collection has a root README (purpose, license link, supported ansible-core versions, required libraries). Where
  possible, generate the plugin docs from the code.
- Each collection has a `LICENSE` or `COPYING` in its root. Files under a different license say so in their header.

## Playbooks

- Keep playbooks thin, ideally just a list of roles. Logic goes in roles or custom modules, where it can be reused and
  changed in one place.
- Use either `roles:` or `tasks:` (with `import_role` / `include_role`), never both. Why: the execution order between
  the two isn't obvious.
- Tags should be one of two kinds: a role-name tag that switches a single role on or off, or a purpose tag that
  achieves something meaningful on its own. Never require users to combine tags in the right order. Document every
  tag.
- Give `debug` tasks an appropriate `verbosity` so they stay available for troubleshooting without cluttering normal
  output.

## Inventories and Variables

- Find the single source of truth for each kind of data (cloud APIs, Satellite, a CMDB) and combine them with dynamic
  inventory plugins. Keep data statically in the inventory only when it has no other home.
- Keep discovered state (as-is, which is what facts are) separate from desired state (to-be, which is what variables
  are). Why: if the two get mixed, automation can conclude there is nothing to fix when there is.
- Use an inventory directory, not a single file: host and group lists, plugin configs, and `group_vars/<group>/` and
  `host_vars/<host>/` directories holding several files each. Name the vars files after the role they configure, and
  reserve `ansible.yml` for connection settings. Keep variables out of the hosts and groups file.
- Loop over hosts through the inventory, not a variable that holds a list of hosts. Why: you get parallelism,
  `--limit`, group inheritance, and no duplicated host data.
- Limit yourself to a few kinds of variables: role defaults, inventory vars, role vars as constants, block or task
  scope for temporary values, and runtime values from `register`. Avoid play variables, `include_vars`, and scoped role
  params. Why: Ansible has more than twenty precedence levels, and fewer kinds keeps the picture readable.
  Remember that every kind still shares one namespace.
- Describe desired state entirely in the inventory. Keep extra vars for troubleshooting, safety switches on destructive
  plays, and simulated facts. Why: extra vars vanish with the job, so nobody can later tell what state was intended.

## Plugins

- Follow Ansible's module and plugin developer guides. Python plugins follow PEP 8, use type hints, and use
  Sphinx-style (reST) docstrings.
- Document every plugin: its inputs, its outputs, and examples.
- Unit test with `pytest`, not `unittest`.
- Keep the plugin entry file small. Move shared logic into `module_utils/` or `plugin_utils/`.
- Within a collection, pick one style for hand-written argspecs and stick to it.
- Error messages should say exactly what failed. Use the module and Display helpers for warnings and verbosity-gated
  output.

## Coding Style

### Naming

- Use `snake_case` valid identifiers for variables, keys, and files. Use no special characters other than underscore.
  Why: other characters break in Jinja2 and Python, and Ansible has dropped tolerance for them before.
- Use full descriptive names. `object[_feature]_action` sorts well. Don't number roles or playbooks.
- Name every play, task, and block. Write task names in the imperative ("Ensure service is running").
- Name booleans positively (`foo_enabled`, not `foo_disabled`) to avoid double negatives in conditions.

### YAML and Jinja2

- Indent two spaces, and indent list items under their key.
- Write module arguments as YAML mappings, never `key=value`.
- Booleans are `true` / `false` only. Why: YAML 1.2 drops `yes` / `no`.
- Use `.yml`, and name templates after their destination plus `.j2` (`example.conf.j2`).
- Quote user-facing strings with double quotes, single quotes inside Jinja2. Don't quote short keywords like
  `present`.
- Put one space inside Jinja2 delimiters: `{{ var | default('x') }}`.
- Wrap long lines. Use `>-` (not `>`, which adds a trailing newline), write long `when` conditions as a list (which
  means "and"), split Jinja2 expressions across lines, and use backslash continuation in double-quoted strings.
- Prefer clear task names over comments. Variables are documented in `defaults` and `vars`.
- Use JSON syntax only where it helps, such as generated files.
- Split long templates by section. Use filter plugins, not Jinja2, to build structured data.
- Mark literal brace-containing strings `!unsafe` so Jinja2 leaves them alone.

### Ansible usage

- Always use FQCNs (`ansible.builtin.copy`), which the ansible-lint production profile enforces.
- Make every task idempotent. Remember that variables are evaluated lazily.
- Prefer a dedicated module, then `command`, then `shell` (only when you need shell features). Add a comment
  justifying each `command` or `shell` use.
- Avoid `lineinfile`. Prefer a config-specific module, `ini_file`, `blockinfile`, or a full `template`, and comment
  when `lineinfile` is unavoidable.
- Use `template` rather than `copy` for most file pushes. Keep `copy` for static files, remote copies, and binaries.
- Pass lists to modules that accept them (`name: "{{ foo_packages }}"`) instead of looping one item at a time.
- Use generic modules (`package`, `service`) only when needs are minimal. If you must branch per platform anyway, use
  the specific module.
- Retrieve values with brackets (`item['key']`). Why: dot notation fails on some names and collides with dictionary
  methods.
- Apply `| bool` to bare variables in `when`. Cast user inputs with `int`, `float`, or `bool` before numeric work,
  since they may arrive as strings.
- Use `meta: end_host`, not `meta: end_play`. The latter stops every host.
- Put dynamic parts at the end of task names. Never template play names, or put loop variables in task names.
- Don't reassign role inputs with `set_fact`; use a new name. Why: facts can't be unset and stick for the rest of the
  play. Keep variables in the narrowest scope.
- Use handlers instead of `when: result is changed`.
- Beware `ignore_errors: true`, especially on test blocks, where it silently disables the asserts.
- Split large or deeply nested task files, and use include/import to share conditions or loops across groups of tasks.

## AAP Configuration as Code

- Keep every AAP object in Git as YAML and apply it with `infra.aap_configuration`. Make no UI changes for anything
  that can be code. Why: you get history, reproducibility, recovery, and no drift.
- Apply through the `dispatch` role. It orders objects by dependency: organizations, credential types, credentials,
  projects, inventories, job templates, workflows, schedules.
- Lay out per-environment config as `group_vars/all/` for shared values plus `group_vars/aap_<env>/` for overrides.
- File by coupling. Shared resources (credentials, inventories, teams, schedules) get one file per type. Tightly
  coupled resources (execution environment, project, job template) go in one bundle file per job template, so they
  change in the same commit.
- Keep secrets out of the definitions: use `lookup('env', ...)` or vault.
- Pin `infra.aap_configuration` to an exact version in `collections/requirements.yml`.
- Prove idempotency (the second run reports `changed=0`) and preview with `--check --diff` before production.
- Apply only from CI/CD on Git events, never from a workstation.

## Git Workflow and Versioning

- Use trunk-based development: one `main` branch, short-lived feature branches (hours to days), and no environment
  branches. Promote with tags, not branches.
- Pick one versioning scheme and use it everywhere. SemVer suits published collections; CalVer (`YY.M.D-PATCH`,
  PEP 440 compatible) suits internal platforms with frequent releases.
- Release tags are annotated and immutable. Fix a bad release with a new patch tag, never by moving the old one.
- Promote the same tag unchanged through every environment, and track what is deployed where outside Git.
- Production never references `latest`, `main`, or any other mutable ref. Use a tag or a digest.
- Give every component of a release the same version: tags, collections, execution environment images, AAP
  references.
- Protect `main`: no direct commits, at least one approving review, CI must pass, no force pushes.
- Call out breaking changes in the tag message and in CHANGELOG.

## Testing

- Test as early as possible: local runs, then pre-commit, CI, integration, and production-like environments. Most
  tests sit at the cheap end: `yamllint`, `ansible-lint`, `--syntax-check`; then pytest and Molecule; then a few
  end-to-end tests.
- Run `ansible-lint` with the `production` profile, both in pre-commit and in CI.
- Every role has at least one Molecule scenario (create, converge, idempotence, verify, destroy), with one per
  supported OS family.
- Unit test custom modules, filters, and lookups with pytest, using independent Arrange-Act-Assert tests.
- Verify idempotency in every test run. Writing idempotent code and testing for it are separate obligations.
- Test names state the behavior and the expected outcome.

## CI/CD and Promotion

- Use pre-commit in every repo: yamllint, ansible-lint, secret detection, YAML validity, end-of-file and whitespace
  fixers.
- CI reruns the same hooks, because local hooks can be skipped.
- Keep PR pipelines under about five minutes: caching, parallel jobs, running only what the change affects.
- Keep testing (CI, no production credentials) separate from building and releasing (CD, approved code only).
- Gate each promotion: Dev needs CI green; QA adds review and sign-off; Prod adds a clean security scan, change
  approval, and a documented rollback plan.
- Automate PR checks beyond lint: size limits, semantic titles, flags on production config changes, docs-updated
  checks.
- Keep release manifests that record exact SHAs, collection versions, and image digests for each environment.
- Write the rollback procedure before you promote.

## Security

- No secrets in Git, ever, including in history. Use vault, environment lookups, an external secret manager, or AAP
  credentials.
- Detect secrets in pre-commit and in CI (`detect-secrets`, plus `gitleaks` on history). Turn on server-side push
  protection, the only layer that stops a secret before it lands.
- Least privilege for every account and pipeline. Test pipelines never see production secrets.
- Playbooks reference AAP credentials by name and never hold their values.
- Rotate service credentials on a schedule (roughly 90 days for tokens and passwords), automated where possible.
- Scan execution environment images (Trivy, Grype) and produce an SBOM (Syft) for every release. Fail on high or
  critical findings in production.
- Treat Git as the audit trail, so changes made in the UI count as security gaps.
- Segment networks between environments, and review accounts, credentials, pipeline access, and RBAC periodically.
