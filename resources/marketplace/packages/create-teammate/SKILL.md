---
name: create-teammate
description: >-
  Create and direct persistent teammates. Use when work is recurring, needs its own accumulated memory, or should run unattended later, and when deciding between a teammate, an instance, and just doing the work yourself.
metadata:
  version: "1.0.0"
---

# Creating Teammates in Vyotiq

A teammate is a durable identity: a name, a role, a private memory namespace per
project, an optional pinned model, and a queue of work it runs one task at a
time. It outlives every conversation.

The tool descriptions tell you what each call takes. This tells you when a
teammate is the right answer and what separates one worth keeping from one that
is just a slower chat.

## Instructions

### First decide whether to create one at all

Three things look similar and are not:

| You need | Use | Lives for |
| --- | --- | --- |
| A second pair of hands for the next twenty minutes | `spawn_agent_instance` | This run |
| Something that remembers, and takes work while nobody watches | `teammate_create` | Forever, until deleted |
| Neither — you can just do it | the ordinary tools | — |

Create a teammate when at least one is true:

- **The knowledge should survive.** You are establishing conventions, decisions
  or context that the next session would otherwise have to be told again.
- **Two workstreams should not share a brain.** A frontend specialist and a
  release operator holding one pile of notes is worse than either alone.
- **Work should run while the user is away.** Only a teammate takes a queued or
  scheduled brief.
- **This job deserves a different model.** Pin a cheap one to routine work and
  keep the expensive one for the chat.

Do not create one for a task you can finish in this conversation. The ceremony —
a name that can never be reused, a memory namespace, a roster row — buys nothing
there, and `teammate_list` is where the cost shows up for every later run.

Never create one *speculatively*, or one per task. There is no cap on how many a
run may create, and no cleanup: the roster is the user's, and filling it is a
mess only they can see.

### Then write one worth keeping

`teammate_create` takes four identity fields. They are not interchangeable, and
each lands in the system prompt as a distinct line of `<response_style>`:

| Field | Becomes | Holds |
| --- | --- | --- |
| `name` | `Name: you are "…"` | What it is called. The id is slugified from it. |
| `persona` | `Role: …` | **What it is** — the job, and the lines it does not cross. |
| `identity` | `Identity: …` | **What it knows** — durable context it carries into every run. |
| `tone` | `Tone: apply this tone…` | **How it writes back.** |

Write `persona` as a role with a boundary, not an adjective:

- Weak: `A helpful frontend assistant.`
- Strong: `Owns the design system and the renderer. Reads backend code to
  understand a contract, never edits it. Refuses work that belongs to the API
  team and says who it belongs to.`

Put facts in `identity`, not `persona` — it is the half that survives a rename:

- `Styling lives in src/renderer/src/lib/ui. pnpm, not npm. Runs vitest before
  claiming anything is done.`

Leave `tone` empty unless the user asked for a voice. An invented tone is the
fastest way to make a teammate feel wrong to the person who has to read it.

Pick an `avatar` from the keys the tool description lists. Anything else falls
back silently to a letter.

### Give it something to know

`teammate_create` takes an optional `memory`, written to its `index.md` for the
open project. This is the **only** way anything puts notes in another teammate's
namespace: `memory_write` always targets the calling run's own, and the write
guard refuses to reach across.

`index.md` is injected into every step of every run it does, so it is an index,
not a document. Durable facts and pointers only:

```markdown
# What Scout knows

- The design system lives in src/renderer/src/lib/ui; `cn()` has no
  tailwind-merge, so an appended utility never overrides an earlier one.
- Styling questions: notes/tokens.md
- The 2026-09 decision to drop the legacy theme: notes/theme-decision.md
```

Seed it from what the user actually told you in this conversation. Do not invent
project facts to fill it — a confidently wrong `index.md` is read by every later
run and is invisible until it causes harm.

### Behaviour fields: ask before widening

`autonomous_mode: 'on'` makes a teammate skip approval prompts. You are allowed
to set it, and the high-risk gate still holds for every teammate — `edit`,
`str_replace`, `delete`, `terminal`, `git_commit`, `git_apply`, the GitHub tools
and every MCP call stay gated whatever this says. But it is the user's
machine and their judgement. Set it when they asked for a teammate that works
unattended; otherwise leave it on `inherit`.

Same for `auto_resume_on_launch`: useful for long jobs that must survive a
restart, noise otherwise.

### Hand it work, and read the result

```
teammate_assign_task  id, prompt, scheduled_at?   → runs in its own session
teammate_task         action: 'result', task_id   → what it produced
teammate_task         action: 'cancel' | 'retry'  → stop it, or run it again
```

A teammate runs **one task at a time**; anything else queues. Nothing streams
back to your conversation — `teammate_task result` is how delegated work returns
to you, and a task still running says so rather than inventing an answer. The
app must stay open for a scheduled task to fire.

Write the brief as you would to a person: the outcome, the constraints, and how
they will know it is done. The brief becomes one user message on the normal run
path, so anything you would say to a colleague works.

### What you cannot undo

- **Deleting retires the id forever.** A later teammate can never inherit that
  slug, its history or its memory. Renaming is safe and keeps everything; deleting
  to "fix" a name is not.
- **Narrowing `scope` from global to one workspace strands** that teammate's
  chats and queued tasks in every other project.
- **Deleting keeps memory and run history** and stops live work first. The only
  thing that erases memory is clearing it from the Teammates pane.

## Verify

Never report a teammate as ready without checking it:

1. `teammate_list` — the row shows the id, persona, scope, pin and autonomy you
   intended, and no "not usable in this project" note.
2. Hand it one small real task, then `teammate_task` with `action: 'result'` and
   read what came back. A teammate that cannot complete a trivial brief is not
   configured, it is broken.
3. Tell the user the id, what it knows, and what it will and will not touch.

## Output

Report, in this order:

- **Created** — name, id, and the one sentence that says what it is for.
- **Knows** — what you seeded into its memory, or that you seeded nothing.
- **Behaviour** — pinned model, approval mode and scope, only where they differ
  from the default.
- **Checked** — the task you gave it and what it returned.

## When not to use this skill

- A one-off you can finish in this conversation — just do it.
- Parallel work inside this run — that is `spawn_agent_instance`.
- Changing an existing teammate — `teammate_update` touches only the fields you
  pass; you do not need this skill to edit one.
