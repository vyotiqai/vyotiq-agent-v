---
title: Rules and skills
description: Which rule files Agent V reads and in what order, rule frontmatter, your own global rules, and how skills load when a task needs them.
group: Extend
order: 2
---

Rules and skills are both plain markdown. The difference is when the agent reads them:

- **Rules** go into the agent's context on every step, when a matching file is open or the agent works on one, or when you @-mention them.
- **Skills** keep only their name and description in the context until a task calls for one.

## Rule files Agent V reads

### Root files

Agent V reads these from the workspace root, in this order:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `.cursorrules`

Root files are always added as they are, frontmatter included, up to 64K characters each.

### Files in sub-folders

The same three names also count in sub-folders, for the part of the project under them. When the agent first reads or edits a file under `packages/api/`, `packages/api/AGENTS.md` is attached to that tool result, and so is any `AGENTS.md`, `CLAUDE.md` or `.cursorrules` in the folders between it and the root. Each one is attached once per task. Folders holding other people's code, such as `node_modules`, `vendor`, `dist`, `build` and `.git`, are skipped.

They arrive with the tool result rather than in the instructions the agent starts with, so the part of each request that the provider caches doesn't change mid-task.

### Rule folders

Agent V also reads rule files from two folders in the workspace:

| Folder | File types |
| --- | --- |
| `.cursor/rules/` | `.md` and `.mdc` |
| `.vyotiq/rules/` | `.md` |

It reads up to 24 rule files in total, root files included.

On the "New task" page, the "Rules" row under "What the agent will see" names the root rule files it found and counts the rule-folder files added on every step. Click it to open the "Rules" tab in Extensions.

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
| `globs` | The rule is added while a matching file is open in the Files panel when you send, and attached the first time the agent reads or edits a matching file. Write several on one line, separated by commas, with or without square brackets: `globs: src/**, db/**`. |
| `alwaysApply: false` (no `globs`) | Not added on its own. @-mention the rule in the composer to add it to that message. Extensions shows it as "On request". |
| `description` | A short summary shown with the rule |

A rule with no frontmatter is added on every step. So is a rule whose frontmatter sets neither `alwaysApply` nor `globs`.

## Your own rules

User rules apply to every workspace. Create one in Extensions, "Rules", with "New rule" and "User rule". You can have up to 16, each up to 4,000 characters, and switch each one on or off.

When a user rule and a workspace rule disagree, the workspace rule wins.

"New rule" also offers "Project rule", which creates a file in `.vyotiq/rules/` set to `alwaysApply: true`. In the composer, `/create-rule` does the same. Settings, "Agent", "Rules" has "Manage rules", which opens the "Rules" tab.

## Skills

A skill is a folder with a `SKILL.md` file in it. The file must start with frontmatter that has a `name` and a `description` saying when to use the skill, and the body holds the instructions. The folder can hold other files the skill refers to.

Agent V looks for skills in three places:

| Folder | Scope |
| --- | --- |
| `.vyotiq/skills/` | This workspace |
| `.cursor/skills/` | This workspace |
| `~/.vyotiq/skills/` | You, in every workspace |

If two skills share a name, the workspace one wins, then yours, then one from the catalog, then one from a package.

The "Skills" tab in Extensions lists catalog skills and the skill folders above. "New skill" creates a "User skill" in `~/.vyotiq/skills/` or a "Workspace skill" in `.vyotiq/skills/`. In the composer, `/create-skill` makes a workspace skill and `/create-skill personal` makes a user skill.

### Skills load on demand

A skill's full text is not sent with every step. The agent sees the list of available skills. When one matches the task, it loads that skill's `SKILL.md` with the `Skill` tool, and the record shows a "Loaded skill" row. Loading a skill only asks when "Ask before" in Settings, "Agent", is set to "Every tool".

You can also run a skill yourself as a slash command in the composer. A skill whose frontmatter sets `disable-model-invocation: true` is left off the agent's list, but its slash command still works.

## Related

- [Extensions](/docs/extensions) for the catalog and packages
- [Writing a task](/docs/writing-a-task) for "What the agent will see"
