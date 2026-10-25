---
name: sliced-implementation
description: >-
  Implement one thin approval-bounded slice with tests, then stop. Supports method slices and vertical path slices.
  Use when the user asks to implement the next method, a vertical or thin thread through modules, method-by-method
  work, or an approval loop and wait.
---

# Sliced Implementation

## When

The user controls scope per turn: one slice, then review, then the next. Never batch multiple slices in one turn.

## Choose the Slice Mode

Decide before editing:

- **Method slice:** One public function or method. Prefer this when the next uncertainty is inside one pure module
  (encoding, validation rules, a single store primitive) and callers are not the open question.
- **Vertical slice:** One thin end-to-end path for one named scenario through the modules that path needs. Prefer this
  when integration across readers, planners, stores, or runners is the open question.

If the user names a mode, use it. If they say "next method," use a method slice. If they say "vertical," "thin
thread," or "path through," use a vertical slice. If unclear for multi-module protocol work, prefer vertical and state
the scenario in one sentence before coding.

## Method Slice Steps

1. Identify the active module from the open files or the user's request.
2. Pick the first unimplemented public function or method that unblocks the next contract. Prefer a pure helper over
   I/O. Do not start a second method.
3. Implement only that function. Leave the remaining not-implemented stubs in place.
4. Add unit tests for success, failure, and one edge case in the same turn.
5. Run the format, lint, type check, and test commands `AGENTS.md` lists, scoped to the new tests where the runner
   allows.
6. If an `implementation-handoff` skill is available, use it to leave a compact handoff: the implemented method, tests,
   verification, the next method, open choices, and out-of-scope stubs. Do not perform extra discovery solely for the
   handoff.
7. Stop. Summarize the method, any steerable contract choice, and the next method. Do not continue until the user
   approves.

## Vertical Slice Steps

1. Name one concrete scenario in one sentence: inputs, expected outcome, and which I/O edges are real or faked. For
   example: "a one-record fixture plus a frozen lookup table yields a planned output matching a golden digest."
2. List the minimum call chain for that scenario only. Do not include sibling entry points (recovery, refresh, idle
   loops, schema migration, selection) unless the named scenario is specifically that branch.
3. Implement only the functions and private helpers on that path that the scenario exercises. Every other public
   method stays a not-implemented stub. Do not "finish" a module while threading the path.
4. Prefer fakes or narrow test doubles at far I/O edges until that seam is the scenario under test. Do not stand up
   full databases, queues, or runner loops unless the scenario requires them.
5. Add tests only for this thin path: one success path through the chain, plus one failure or edge on the same path.
   Do not add broad coverage for unstubbed methods or alternate branches.
6. Run the format, lint, type check, and test commands `AGENTS.md` lists, scoped to the new path tests where the runner
   allows.
7. If an `implementation-handoff` skill is available, use it to leave a compact handoff: the scenario, newly
   implemented modules and methods, what remains stubbed, tests, verification, the next candidate scenario, and open
   choices.
8. Stop. Summarize the scenario, steerable contract choices, and the next thin scenario. Do not continue until the
   user approves.

## Thin-Slice Hard Limits (Both Modes)

- One slice per turn. No second method, second scenario, or "while we're here."
- Scope is the minimum needed for the named unit. Leave unused public methods stubbed even when they sit in a file you
  edited.
- Do not implement adjacent branches (retry matrices, refresh, reconciliation, shutdown, schema setup, backfill)
  unless they are the slice.
- Do not expand private helpers into a parallel public API.
- Do not replace stubs with placeholders, empty successes, or partial writes that look complete.
- If the path needs a large surface to work at all, stop and propose splitting it into smaller scenarios instead of
  widening the turn.
- Propose tests at the checkpoint; do not skip them because the slice is small.
- Do not commit unless the user asks.
- If the next slice is unclear, say so and wait instead of guessing.
