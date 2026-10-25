---
description: When working in design/, draft plan.md only if asked; otherwise write your own notes file
paths:
  - design/**/*.md
---

# Plan Files

Apply this rule whenever you create or edit files under `design/`.

- When the user asks to draft a plan, write `design/<feature-slug>/plan.md`. Use a short lowercase slug.
- When the user asks for review or feedback, write your own `<model>-notes.md` in that directory, named after the
  model or tool you are, such as `claude-notes.md` or `codex-notes.md`. Leave `plan.md`, `review.md`, and
  `decisions.md` unchanged unless the user asks you to update them.
- Notes files are scratch. Never edit another model's notes file. Append a dated section when yours already exists.
- Keep notes terse. Put a disagreement in your own notes. Do not paste a chat transcript.
- `plan.md` and `decisions.md` are the committed record. Commit them only when the user asks.
