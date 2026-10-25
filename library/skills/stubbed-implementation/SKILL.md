---
name: stubbed-implementation
description: >-
  Scaffold a settled new feature or in-place change into real data contracts, updated interfaces, and explicit
  behavior stubs. Use when the user asks to stub out, scaffold, or skeleton work before implementing its behavior.
---

# Stubbed Implementation

## When

Use this skill after a design or contract is settled and before behavior is implemented. It supports both greenfield
features and changes that replace or extend existing code. The skeleton is the last cheap place to expose a missing
field, unclear interface, activation problem, or incompatible call site.

`sliced-implementation` fills the skeleton afterwards in thin approval-bounded slices: method slices for local pure
work, vertical path slices when cross-module integration is the open question.

## Choose the Change Mode

Decide this before choosing files or names:

- **Greenfield or additive:** No current contract is being replaced. Add the new structures and stubs beside the live
  path, and leave existing behavior working.
- **In-place evolution:** The new contract replaces the current one. Update the canonical modules, data structures,
  constants, signatures, and exports directly. Do not create a versioned module, compatibility alias, or schema
  dispatcher unless simultaneous versions are an explicit requirement.

Backward compatibility and activation timing are product decisions, not defaults. If the contract does not settle
which mode applies and the choice would materially change the structure, ask before editing.

## Workflow

1. Read the contract first: the design doc, decision log, task list, and any scoped project rules. Transcribe settled
   decisions; treat anything else as an open question rather than guessing.
2. Inspect the nearest implementation and map the affected surface: types, constructors, serializers, call sites,
   interfaces, runners, persistence, tests, and documentation. Mirror the existing module layout and naming.
3. Write contract data for real:
   - constants and environment variable names, never magic values
   - records, enums, type aliases, and other typed structures, with their final fields, immutability, and field order
   - class definitions, exports, and signatures with complete type annotations and the documentation style the
     repository uses
4. Stub only newly introduced behavior. Each new function or method has its documentation and exactly one executable
   statement that raises the language's not-implemented error and names the specific missing behavior, such as
   `raise NotImplementedError("...")` in Python or `throw new Error("not implemented: ...")` in TypeScript.
5. Evolve existing behavior without pretending it is new:
   - retain the existing implementation when its semantics are still valid
   - place a precise `TODO(<feature>)` at the exact boundary that must change
   - make mechanical edits required by the new contract, including signature, import, field-name, constructor,
     return-type, and argument-plumbing changes
   - route orchestration through a new stub when new behavior is required, so an incomplete path fails explicitly
     instead of producing a plausible but invalid result
   - if type correctness requires an unresolved behavioral decision, stop and report that decision instead of
     inventing a placeholder
6. Sweep every consumer of a changed type or signature. Update fixtures, builders, dependency wiring, serialization
   order, persistence boundaries, and operator docs enough that imports, test collection, and static checking describe
   one coherent contract.
7. Add contract tests only for the skeleton itself: field order, constant values, exported names, signatures, and
   serialization key order. Update existing test data to the new structure, but do not add a test whose purpose is to
   assert that a stub raises.
8. Run the format, lint, type check, and test commands `AGENTS.md` lists, including test collection, the new contract
   tests, and unaffected focused tests. Run the full suite when it is expected to pass. For an in-place replacement,
   identify behavioral tests blocked by intentional stubs; do not delete or skip them merely to make the build green.
9. Stop and report the module map, activation state, verification performed, open questions, intentionally blocked
   tests, and the first public method to implement.

## Rules

- Data structures and interfaces are the deliverable; new business behavior is deferred. Field order is part of the
  contract wherever it drives serialization.
- The one-statement stub rule applies to new functions and methods, not to existing implementations that receive TODOs
  and mechanical contract updates.
- Use actionable TODOs. Name the feature and the exact work or condition for removal; avoid comments such as
  `TODO: update this`.
- Never use empty bodies, placeholder returns such as `None`, `undefined`, or empty collections, fake defaults,
  optional fields, or sentinel records to disguise missing behavior or preserve compatibility that was not requested.
- Do not duplicate an existing implementation into a new versioned module just to isolate stubs. Separate versions
  only when the contract requires them to run concurrently.
- Do not catch the not-implemented error or add a fallback around a stub. An incomplete activated path must fail
  visibly.
- Preserve valuable existing tests even when an in-place skeleton temporarily blocks them. If the repository requires
  every commit to be green, keep the skeleton inactive or obtain approval to include the first implementation slice;
  do not weaken the tests.
- Import only what current signatures, annotations, and retained bodies use.
- Do not add speculative helpers, parameters, configuration, or extension points that the contract does not name.
- If an `implementation-handoff` skill is available, hand off with it, naming the first public method to fill in and
  any existing methods that depend on it.
- Do not commit unless the user asks.
