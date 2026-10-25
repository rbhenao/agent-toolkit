---
description: Keep Ansible role contracts small, consistent, and DRY when changing roles, playbooks, or inventory
paths:
  - ansible/**/*.yml
  - ansible/**/*.yaml
  - ansible/**/*.j2
references:
  - ansible/good-practices-for-ansible.md
---

# Ansible Design

Reference: `.agents/references/ansible/good-practices-for-ansible.md`, a digest of the Red Hat Community of Practice
"Good Practices for Ansible". Open the section that matches the change, such as Roles, Playbooks, or Inventories and
Variables, rather than reading the whole digest.

Apply this rule when changing role variables, defaults, argument specs, templates, inventory layout, or role
boundaries.

- Shared project inputs should stay shared; do not create role-prefixed duplicates without a real need.
- Role contracts must stay consistent across defaults, argument specs, tasks, templates, and inventory.
- Prefer one authoritative source for common values such as paths, users, groups, and versions.
- Keep roles focused on one purpose and keep playbooks simple.
- Favor explicit validation and clear variable naming over implicit behavior.
- Reduce boilerplate only when the resulting contract is clearer, not just shorter.
