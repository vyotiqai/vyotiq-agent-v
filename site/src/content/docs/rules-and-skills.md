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

Agent V reads these from the workspace root, in this order, so a project set up for another agent works as it is:

1. `AGENTS.md`
2. `CLAUDE.md`
3. `CLAUDE.local.md`
4. `GEMINI.md`
5. `.github/copilot-instructions.md`
6. `.cursorrules`

Root files are always added as they are, frontmatter included, up to 64K characters each. With none yet, `/init` has the agent write an `AGENTS.md` for you (see [Built-in commands](#built-in-commands)).

A root file can pull in another file with `@path`, as Claude Code's `CLAUDE.md` does: `See @docs/style.md` adds `docs/style.md` right after it, and that file's own `@path` lines are followed too, three levels deep. The path is relative to the file that names it and must stay inside the workspace. A token needs a `/` or a file extension to count, so `@alice` is left alone, and `@path` inside code is ignored.

### Files in sub-folders

The same names also count in sub-folders, for the part of the project under them. When the agent first reads or edits a file under `packages/api/`, `packages/api/AGENTS.md` is attached to that tool result, and so is any `AGENTS.md`, `CLAUDE.md` or `.cursorrules` in the folders between it and the root. Each one is attached once per task. Folders holding other people's code, such as `node_modules`, `vendor`, `dist`, `build` and `.git`, are skipped.

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

Agent V looks for skills in these places, so skills written for Claude Code, Cursor or the `.agents` convention work without copying:

| Folder | Scope |
| --- | --- |
| `.vyotiq/skills/` | This workspace |
| `.claude/skills/` | This workspace |
| `.agents/skills/` | This workspace |
| `.cursor/skills/` | This workspace |
| `~/.vyotiq/skills/` | You, in every workspace |
| `~/.claude/skills/` | You, in every workspace |

If two skills share a name, the first folder in that list wins: the workspace's, then yours, then one from the catalog, then one from a package. A skill from another agent's folder says where it was read from on its page in Extensions. Extensions lists such a skill once, as the copy the agent uses, with "also in" and where the other copy is.

The "Skills" tab in Extensions lists catalog skills and the skill folders above. "New skill" creates a "User skill" in `~/.vyotiq/skills/` or a "Workspace skill" in `.vyotiq/skills/`. In the composer, `/create-skill` makes a workspace skill and `/create-skill personal` makes a user skill.

### Skills load on demand

A skill's full text is not sent with every step. The agent sees the list of available skills. When one matches the task, it loads that skill's `SKILL.md` with the `Skill` tool, and the record shows a "Loaded skill" row. Loading a skill only asks when "Ask before" in Settings, "Agent", is set to "Every tool".

You can also run a skill yourself as a slash command in the composer. A skill whose frontmatter sets `disable-model-invocation: true` is left off the agent's list, but its slash command still works.

## Commands

A command is a markdown file whose body becomes your instruction when you type `/` and its name. The file's name is the command (`review.md` is `/review`), unless its frontmatter sets `name`, and `description` is the line shown in the `/` menu. Agent V reads them from:

| Folder | Scope |
| --- | --- |
| `.vyotiq/commands/` | This workspace |
| `.claude/commands/` | This workspace |
| `.cursor/commands/` | This workspace |
| `.github/prompts/` (`*.prompt.md` only) | This workspace |
| `~/.vyotiq/commands/` | You, in every workspace |
| `~/.claude/commands/` | You, in every workspace |

When two share a name, the first folder in that list wins.

What you type after the command fills the body's placeholders: `{{input}}` and `$ARGUMENTS` take all of it, `$1` to `$9` take one word each ("quoted words" count as one), and a Copilot prompt file's `${input}` or `${input:name}` take all of it. With no placeholder, your text goes after the body.

A command can also pick the model and the mode, as the picker and the mode switch would, before the task starts. `model:` names one of your models: its id (`claude-haiku-4-5`), the name the picker shows, `provider::model`, or a word only one model carries (`haiku`). If none of your models matches, the command runs with the current one and says so. `mode:` (or a Copilot prompt file's `agent:`) is `ask` or `agent`; `edit` runs as Agent. Like the picker, the choice stays for what you send next. A command sent to a running task goes as is, with a note.

### Built-in commands

Two commands come with Agent V:

- **`/init`** has the agent write an `AGENTS.md` at the workspace root: how to install, build, run, test (all and one), typecheck and lint, the layout, and the conventions the code follows, all read from the repository rather than guessed. If `AGENTS.md` is already there, it improves it in place. It runs in Agent mode, and the file lands in Changes, to keep or undo like any other edit. Text after it says what to stress: `/init mention the e2e setup`.
- **`/review`** has the agent review changes for bugs, regressions, security problems and missing tests, most severe first, each with a file, a line and a fix. It doesn't edit, commit or revert anything. It looks at the uncommitted changes, or `/review branch` at everything since the branch left the default branch, or `/review task` at what this task changed. Other text after it is the focus: `/review security only`. The Changes tab's `···` menu has "Review these changes", which sends the same review for the view on screen.

A command file of your own named `init` or `review` (or a skill with that name) takes the place of the built-in one.

## Related

- [Extensions](/docs/extensions) for the catalog and packages
- [Writing a task](/docs/writing-a-task) for "What the agent will see"
