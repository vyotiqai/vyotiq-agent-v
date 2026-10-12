---
title: The task record
description: How to read a task's record, its plan and steps, the receipt line, and how to add instructions to or stop a live run.
group: Tasks
order: 2
---

Once a task starts, its page becomes a record: your brief at the top, then the work, then the result. The record is written as the run happens, so you can read it live or come back to it later.

## Work rows

A run's work sits behind one line above its answer. While the run works, the line is open and reads "Working", with the step it is on (or how many steps run side by side, when instances work on several at once), or "Waiting for you" when something needs your answer. When the agent starts writing its answer, the line folds to "Writing the answer" and the answer appears under "Result" as it is written. Once the run answers, the line folds itself to what the work took, for example "Worked for 3m 23s · 4 steps · 12 lookups · 3 commands · 2 edits", so the answer sits a few rows under your brief. Click the line to open it again. A run that failed, stopped, or ended without an answer keeps it open, and an error stays in view under a folded line.

Most of what the agent does is a row that starts with a verb. The verb tells you the kind of action before you read the rest of the row. Lookups in a row share one line, and file edits and commands that change things get a card of their own.

| Row | What happened |
| --- | --- |
| "Read" / "Searched" / "Listed" / "Explored" | Read files, searched the workspace or listed folders. A line that mixes three or more kinds of lookup reads "Explored" |
| File card | An edit: the file's path, "new" for a created file, and the lines added and removed |
| "Deleted" | Removed a file |
| Command card | A command that changes things: `$` and the command, its exit code and its time. Read-only commands join the lookup line as "Ran". Its menu has "Copy command", "Copy output" and "Run in my terminal", which types the command into your own shell in the Terminal tab and runs it |
| "Browsed" | Used the agent's browser |
| "Wrote memory" | Saved a note to the workspace's memory |
| "Loaded skill" | Loaded a skill ([Rules and skills](/docs/rules-and-skills)) |
| "Git commit" / "Created PR" | Committed, or opened a pull request |
| "Running instance" / "Instance finished" | A sub-agent it started, with an "Open" link. Several started together share one block ([Instances](/docs/instances)). Inside the step it was started for, the step's row already gives its name, id and time, so its own line only says how it stands and what it is doing |
| "Built a tool" | Wrote a tool of its own ([Agent-built tools](/docs/agent-built-tools)) |

While a row is still running, its verb is in the present tense ("Reading", "Running"). The same call repeated three or more times in a row folds its earlier runs into one line above the last one. A list of more than 200 rows opens on its latest 200, under a line such as "9,800 earlier · Show 200 more"; each click adds 200 more above.

Marking the Done when checks is not a row of its own. The verdicts show with the checks ([Writing a task](/docs/writing-a-task)). While the run is live, the checks are one line under your brief, such as "Done when · 3 checks · checked at the end"; click it to see them.

## Plan and steps

When the agent writes a plan, it shows as a "Wrote the plan" row with an "Open plan" button, which opens the plan in the inspector's "Plan" tab. A plan the app refused, for example because its arguments arrived malformed, shows as "Plan not written" with the reason under it.

The plan's steps then appear as a list. The agent updates them as it goes. The bottom edge of the task header becomes a plan bar with one segment per step: hover a segment to see its step, and click it to go there.

- Only the step the agent is working on is open. The others are one line each, with their time on the right. Click a step to open it.
- A step a later plan dropped or renamed is tagged "replaced".
- A step waiting on an approval or a question stays open with the card inside it. If you fold it, it shows "Waiting for you", which opens it again.
- Work done while no step was in progress sits after the step it followed.

While the run is live, a "Now" row shows what the agent is doing at that moment when there is more to say than "Working", such as reconnecting or compacting. While its instances work in their steps, it sits after the steps. If you scroll up, "Jump to now" (or `End`) brings you back.

## The result

When the run ends, the agent's closing answer appears under "Result", with the files it changed. Each file opens in Changes. Until you review them, the edits are counted as "{N} files changed, not kept yet" with "Review changes". After review the line says what happened, for example "Kept, not committed yet" with "Commit…".

The answer, and everything else the agent writes in the record, can be acted on where it stands:

| In the answer | What you can do |
| --- | --- |
| A file path, such as `src/auth/session.ts:58` | Click it to open the file in the Files tab at that line. A bare file name, such as `index.ts`, opens the one file of that name; when the workspace has several, Files lists them to pick from |
| A heading, in an answer of several parts | "Copy this section" copies the part under it |
| A code block | "Copy" copies it, and "Wrap" wraps long lines. A block over 20 lines folds; "Show all {N} lines" opens it |
| A shell block | "Copy commands" copies the commands without their `$` prompts or output |
| A diff | Shows a `+`/`−` sign on each changed line and the lines added and removed |
| A table | "Copy table" offers "Copy as Markdown" and "Copy as CSV" |
| A diagram or chart | Drawn once its block is complete; "Source" or "Data" shows what it was drawn from |
| A view: figures, rows, a table, checks, buttons or a short form the agent laid out for the answer | Drawn as it is written, each row once it is whole. A button, or a row that offers one, either sends its words as your next instruction or does something in the app: opens a file, its diff or a commit, stages files, opens a tab, opens a web page, or runs a command in your terminal, which asks first and shows the command. A button that opens a web page names the site beside its label; a row that opens one asks first and shows the address. Hover it to see which. A part marked "Live from git" (or GitHub, Usage, this task) is the app's own read, kept current, never the model's figures. In an earlier run's answer it stops following: it keeps the read it had and says when that was ("From git at 14:32", with "Refresh"), or waits for "Read now", so it never contradicts the answer around it. When a later answer updates the same view, the earlier one folds to "Updated below". "Data" shows what it was drawn from, live parts included; "Copy" copies it as Markdown |
| Math | `$$…$$` inside a sentence, a `$$` block on its own lines, a ` ```math ` block, and the `\(…\)` and `\[…\]` other models write are typeset. A single `$` stays text, so prices and `$HOME` read as written |

Images load only when the app made them; a link to an image elsewhere shows as a link to open instead.

The agent can also draw a view while it works: a table of what it is migrating that ticks each row to done, or the tests as they run. Its views sit after the work and above the answer, one place per view, each updated where it stands, and they stay there once the work folds. The work keeps a "Showed a view" row for each update. A question the agent asks can carry a view too, above the question, laying out what the choice is between.

Ask about the workspace's state in the composer like anything else ("what's uncommitted?", "how is CI doing?", "what did I spend this week?") and the answer comes as a view with live parts. Hover a view with live parts for "Pin to Home": it keeps those parts under "Screens" on Home, which shows only once something is pinned. A pinned view opens on its saved layout with every value read fresh, with no model call, and "Open task" goes back to the task it came from. Everything the agent typed, figures and notes alike, is left out, since it would go stale there. Each pinned view on Home says what it shows first ("3 uncommitted", "2 failing"), read live, and its menu renames it, moves it up or down, or unpins it; "Unpin" on the open view does the same. Home holds 12 pinned views: pinning another asks you to unpin one first, and views from a workspace that isn't open are counted under a line that lists them, to unpin.

Your brief and each instruction after it sit on the right, as your side of the conversation. Each instruction taken up after a run ends, whether you sent it then or queued it, starts a new run under a "Run {n}" divider, and earlier runs fold into "History". Each History row leads with what you asked, then the first line of the answer. Hover a brief for "Edit and rerun" and for rewinding to before it ([Review and rewind](/docs/review-and-rewind)).

## The receipt

When a run ends, a receipt line sums it up. While the run is live, the same line fills in as it goes. It can include:

| Part | What it is |
| --- | --- |
| Time | Wall time for the run |
| "{met}/{total} checks met" | Done-when checks the agent marked met, counted once the run has ended |
| Cost | "Billed by the provider", or with a `~` in front when "Estimated from published prices". A free model's runs show `$0` |

Tokens, output speed and prompt cache hits are in the line's tooltip. A part is left out when there is nothing to show, and History shows a cost column only once a run has cost something. [Usage and cost](/docs/usage-and-cost) explains how cost is worked out. You can also mark the result helpful or unhelpful from the receipt, or click "Run this again" to run the latest instruction again as it was. If the run changed files, it first asks, listing the files that go back to how they were. It also asks if you said something into the run while it worked, since only the instruction runs again. A stopped run's receipt starts with "Stopped" and can offer "Undo its changes" and "Resume".

## Adding instructions while a run is live

The instruction line at the bottom stays open during a run. `Ctrl+L` puts the cursor there. While a run is live, its placeholder reads "Steer it, or queue what comes next…".

| Situation | The one action | Key |
| --- | --- | --- |
| Empty box | "Queue", off until there is something to send | `Enter` |
| Something written | "Send now" | `Shift+Enter` |

While a run is live, the row carries a "Stop" button just before the action; it is gone when no run is live.

Clicking the action does what its label says, and the label follows what you have typed: "Queue" holds the instruction for the end of this turn, "Send now" puts it into the live run straight away, and it shows in the work as "You said …" where the agent took it up. Use it to correct the agent while it works, for example when it has taken a wrong turn. To queue something while you are typing, press `Enter`. Queued instructions wait above the line, each with "Edit", "Send now" and a button to remove it.

## Stopping a run

Press `Esc`, or click "Stop" at the end of the instruction line — its tooltip reads "Stop the run (Esc)". You can also use "Stop" in a task's menu in the navigator. What the agent already changed stays in place; review it in the inspector, keep or undo each file, or rewind. See [Review and rewind](/docs/review-and-rewind).

## Finding things

`Ctrl+F` finds text in the record, the changes, or the pull request, depending on where you are. In the record, find opens the folded steps, earlier runs and earlier rows that hold a match, and `Enter` / `Shift+Enter` move between matches. A command's output is searched too, and a command card with a match opens to show it. The approval cards that appear in the record are covered in [Approvals](/docs/approvals).
