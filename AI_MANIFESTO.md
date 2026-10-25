# AI-Aware TypeScript Design Manifesto

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
8. Use Node built-ins and existing repository idioms before adding a dependency or inventing a framework.
9. Add or update tests with every behavior change.
10. Run the routine checks before calling work done: Prettier, ESLint, `tsc --noEmit`, and Vitest.

## Required rules

- No `catch` that swallows errors. Catch `unknown`, narrow it (an `instanceof` check or a Node error `code` such as
  `ENOENT`), handle only the case you expect, and rethrow the rest. The CLI entry point is the one process boundary
  that turns errors into a message and an exit code.
- No `any`, and no `as` casts or non-null assertions (`!`) used to silence the compiler. Validate untrusted input from
  `unknown` into typed values once, at the boundary.
- No floating promises. Await every promise or return it.
- No hidden configuration inference that changes behavior.
- No new config surface without an immediate use case.
- No function should mix I/O, parsing, business rules, and presentation unless it is trivial.
- No "fallback to the fallback" chains unless required by a documented contract.
- Exported APIs require explicit types and TSDoc. Private helpers need TSDoc only when they clarify a non-obvious
  contract.
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
- Pure functions for business logic; keep file system access at the edges.
- Data-driven dispatch (object maps, or `switch` with an exhaustive `never` check) over repeated `if/else` ladders.
- Discriminated unions over boolean flags and optional-field soup.
- `readonly` data and `const` bindings by default.
- Named constants over magic values.
- `node:path` for paths, and array methods (`map`, `filter`, `some`, `every`) over hand-rolled loops when readability
  improves.
- Narrow interfaces, shallow call stacks, and explicit return types on exported functions.

## Anti-patterns to remove

- Premature abstraction
- Swiss-army functions
- Guessy defaults
- Silent error swallowing
- Nested fallback trees
- Copy-pasted variations that should be one data-driven pattern
- Type assertions standing in for validation
- Dependencies added for what a Node built-in already does
- Tests that only assert the happy path
- Changes that pass by lint loop but still hide unclear contracts

## Review question

Would a new teammate understand what this code does, what it refuses to do, and how to verify it within five minutes?
