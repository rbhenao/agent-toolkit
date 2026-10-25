---
description: Commit or push only when the user explicitly asks, staging only this session's changes
---

# Committing

Apply this rule whenever a commit or push is in question.

- Do not commit or push unless the user asked for it in the current turn.
- When asked, commit only after the change is complete and the repository's verification commands pass.
- Stage only the files changed for this piece of work, by path (`git add <file>...`). Never use `git add -A` or
  `git add .` while the working tree holds unrelated changes.
- Write a clear, imperative commit message focused on why the change was made.
- Split unrelated concerns into separate commits so each diff stays easy to review.
- Check the result with `git status` after committing.
