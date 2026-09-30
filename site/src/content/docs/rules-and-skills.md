---
title: Rules and skills
description: Which rule files Agent V reads and in what order, rule frontmatter, your own global rules, and how skills load when a task needs them.
group: Extend
order: 2
---

Rules and skills are both plain markdown. The difference is when the agent reads them:

- **Rules** go into the agent's context on every step, or when a matching file is in focus.
- **Skills** stay out of the context until a task calls for one.

## Rule files Agent V reads

### Root files

Agent V reads these from the workspace root, in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.cursorrules`

Root files are always added in full, with or without frontmatter.

### Files in sub-folders

The same three names also count in sub-folders, for the part of the project under them. When the agent first reads or edits a file under `packages/api/`, `packages/api/AGENTS.md` is attached to that tool result, and so is any `AGENTS.md`, `CLAUDE.md` or `.cursorrules` in the folders between it and the root. Each one is attached once per task. Folders holding other people's code, such as `node_modules`, `vendor`, `dist` and `.git`, are skipped.

They arrive with the tool result rather than in the instructions the agent starts with, so the part of each request that the provider caches doesn't change mid-task.

### Rule folders

Agent V also reads rule files from two folders in the workspace:

| Folder | File types |
| --- | --- |
| `.cursor/rules/` | `.md` and `.mdc` |
| `.vyotiq/rules/` | `.md` |

It reads up to 24 rule files in total.

Under "Rules", "What the agent will see" on the "New task" page names the root rule files it found and counts the rest.

## Rule frontmatter

A rule in a rule folder can start with frontmatter:

```markdown
---
description: How we write database migrations
globs: db/migrations/**
alwaysApply: false
---

Every migration needs a down step...
```

| Key | Effect |
| --- | --- |
| `alwaysApply: true` | The rule is added on every step |
| `globs` | The rule is added while a file matching one of the patterns is in focus, and attached the first time the agent reads or edits a matching file. Write several on one line, separated by commas, with or without square brackets: `globs: src/**, db/**`. |
| `alwaysApply: false` (no `globs`) | Not added to every step. The agent can ask for the rule when it needs it, and you can run it as a slash command. |
| `description` | A short summary shown with the rule |

A rule with no frontmatter is added on every step.

## Your own rules

User rules apply to every workspace. Create one in Extensions, "Rules", with "New rule" and "User rule". You can have up to 16.

When a user rule and a workspace rule disagree, the workspace rule wins.

"New rule" also offers "Project rule", which creates a file in `.vyotiq/rules/`. In the composer, `/create-rule` does the same. Settings, "Agent", "Rules" has "Manage rules", which opens the "Rules" tab.

## Skills

A skill is a folder with a `SKILL.md` file in it. Its frontmatter names the skill and says when to use it, and the body holds the instructions. The folder can hold other files the skill refers to.

Agent V looks for skills in three places:

| Folder | Scope |
| --- | --- |
| `.vyotiq/skills/` | This workspace |
| `.cursor/skills/` | This workspace |
| `~/.vyotiq/skills/` | You, in every workspace |

Skills from the app's catalog are managed on the "Skills" tab in Extensions. "New skill" creates a "User skill" or a "Workspace skill".

### Skills load on demand

A skill's full text is not sent with every step. The agent sees the list of available skills. When one matches the task, it loads that skill's `SKILL.md` with the `Skill` tool, and the record shows a "Loaded skill" row. With approvals on "Edits and commands", loading a skill does not ask.

You can also run a skill yourself as a slash command in the composer.

## Related

- [Extensions](/docs/extensions) for the catalog and packages
- [Writing a task](/docs/writing-a-task) for "What the agent will see"
