---
description: Apply the AI-aware Python design standard when writing, refactoring, or reviewing Python code
paths:
  - "**/*.py"
---

# AI-Aware Python Design Manifesto

This repository accepts AI-generated code only if it is simpler, clearer, and more verifiable than the code it
replaces.

## Defaults

1. Prefer the smallest change that satisfies the explicit requirement.
2. Prefer explicit contracts over inference.
3. Prefer one obvious path over layered fallbacks.
4. Fail fast on invalid input and impossible state.
5. Keep control flow flat and local.
6. Keep functions and modules single-purpose.
7. Duplicate once if it avoids the wrong abstraction; abstract only after the pattern is proven.
8. Use standard-library and existing repository idioms before adding a dependency or inventing a framework.
9. Add or update tests with every behavior change.
10. Run the routine checks before calling work done: the format, lint, type check, and test commands `AGENTS.md`
    lists.

## Required rules

- No broad `except` unless re-raising or logging at a process boundary. Catch the specific exception you expect and
  let the rest propagate.
- No hidden configuration inference that changes business meaning.
- No new config surface without an immediate use case.
- No function should mix I/O, parsing, business rules, and presentation unless it is trivial.
- No "fallback to the fallback" chains unless required by a documented contract.
- Public APIs require type hints and docstrings. Public means exported module functions, classes, and cross-module
  interfaces such as entry points and data classes shared across modules. Private helpers need them only when they
  clarify a non-obvious contract.
- New branches require tests for success, failure, and edge cases.
- Prefer deleting dead code to preserving speculative flexibility.

## Definition of done

A change is done only when all of the following are true:

- The requirement is explicit.
- The implementation is explainable in a few sentences.
- The changed code follows existing local patterns.
- Format, lint, type check, and relevant tests pass.
- The diff is small enough for a human reviewer to understand quickly.
- Error behavior is intentional and tested.

## Strong preferences

- Guard clauses over deep nesting.
- Pure functions for business logic where practical; keep I/O at the edges.
- Data-driven dispatch over repeated `if/elif` ladders.
- Named constants over magic values.
- `pathlib`, context managers, comprehensions, and built-ins (`any`, `all`, `min`, `max`) over hand-rolled loops when
  readability improves.
- Narrow interfaces, shallow call stacks, and explicit return types.

## Anti-patterns to remove

- Premature abstraction
- Swiss-army functions
- Guessy defaults
- Silent exception swallowing
- Nested fallback trees
- Copy-pasted variations that should be one data-driven pattern
- Tests that only assert the happy path
- Changes that pass by lint loop but still hide unclear contracts

## Review question

Would a new teammate understand what this code does, what it refuses to do, and how to verify it within five minutes?
