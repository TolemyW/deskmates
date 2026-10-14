---
name: skill-creator
description: Design a small Agent Skill with clear triggers, safe files, and verifiable steps.
---

# Skill creator

Use this skill to propose a reusable procedure after the underlying task is understood.

1. Choose one narrow capability and a lower-case kebab-case name. Write a description that says when the skill should be used.
2. Put the procedure in `SKILL.md` with `name` and `description` frontmatter. Keep reference material in small Markdown or text files with relative paths.
3. Prefer existing workspace tools. Do not add executable files, bundled account material, runtime downloads, or instructions that change product security rules.
4. State prerequisites and a clear stop condition. When an external account is required, tell the operator which Connection to configure; never embed its account material.
5. Include observable checks for the result and recovery guidance for partial failure.
6. Test the procedure on a representative task and report limitations. A new skill is a strategy change; do not claim it improves outcomes without a paired evaluation.

Bot-authored skills are proposals from consolidation. Deskmates decides their review state and availability; do not copy files into bot home directories.
