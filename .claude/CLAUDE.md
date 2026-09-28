# Working in this repo

**Change the real code base, not a proposal.** Edit the files in this checkout,
on whatever branch it's on (normally `main`). Don't create a branch, a worktree
(`git worktree add`, `EnterWorktree`, an agent with `isolation: "worktree"`) or
a pull request unless asked for one. Work left on side branches and worktrees
gets stranded — the 2026-09-27 sweep had to rescue eight PRs' worth of it.

- Commit only when asked, and then on the current branch. Don't branch first,
  even on `main`.
- Push only when asked.
- If a session starts inside a worktree (`.claude/worktrees/…`), say so up
  front: work there doesn't reach this checkout until it's merged.

This file lives in `.claude/`, not the root `CLAUDE.md`, because VYOTIQ injects
the root file into its own agent's prompt, and its task instances run in
worktrees on purpose.
