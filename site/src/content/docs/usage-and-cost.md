---
title: Usage and cost
description: What the Usage page shows, how Agent V works out the cost of a run, and what "est." and "~" mean.
group: Review and ship
order: 3
---

Agent V counts the tokens every run uses and, where it can, what they cost. You see this per run on the receipt, and across runs on the Usage page.

## The Usage page

Open it with "Usage" in the navigator, the "Usage" link in Home's "This week" panel, or "Usage" in the command palette. Two controls at the top set what it covers:

- **Workspaces:** "All workspaces", or one open workspace.
- **Days:** "7 days", "30 days", "90 days" or "Custom". "Custom" shows a From and a To date.

"Export CSV" saves the period as a spreadsheet: one row per task per day, with its tokens, its spend and whether that spend was billed or estimated. Spend with no task behind it (a commit message drafted outside a task, say) has its own row, "Commit messages and other side calls, no task".

Each task counts once, with its instances folded into it.

### The five numbers

| Stat | What it counts |
| --- | --- |
| Tasks | Runs in the period, compared with the period before |
| Tokens | Input and output tokens, with the share served from cache |
| Spend | Cost for the period, and the cost per task |
| Finished | The share of ended runs that finished, with how many failed, stopped or are still running |
| Kept | The share of changed files you kept rather than undid. Files still waiting for review are not counted. |

### The charts

| Chart | What it shows |
| --- | --- |
| "Spend per day" / "Tokens per day" / "Tasks per day" | One chart with a Spend, Tokens and Tasks switch. It opens on Spend when any cost was reported. A day with tasks but no cost shows as a dashed line. |
| "Model mix" | Which models the runs used, by output tokens |
| "Tool failures" | Up to five tools that failed most, each with its failures out of its calls and the error it gave most |
| "Unchecked" | Runs with "edits with no passing check after". "Worth a test run before you commit." |
| "Where it went" | Spend (or tokens, when nothing was priced) by workspace, then by task inside each. The smaller tasks fold into one line; Export CSV has every one. |
| "Side calls" | Model calls made beside the tasks' own steps, by kind: compaction summaries, commit messages, structured instructions and MCP server requests (sampling). Already inside the totals above. |

Click a task in "Unchecked" to open it.

## How cost is worked out

For each step of a run, Agent V uses the first of these that applies:

1. **Reported by the provider.** Some providers return the cost with their response. Agent V shows that amount as billed.
2. **Estimated.** Otherwise Agent V multiplies the tokens by the model's USD rates, looked up in this order:
   - **Your own prices**, from Settings, "Agent", "Cost", "Prices", for a provider (or any provider) and a model id. A `*` at the end of the id matches every id that starts with it.
   - **The price table built into the app.**
   - **The models.dev catalog**, which the app already downloads at start for context windows. It prices most models newer than the built-in table, and models on Bedrock, Vertex AI, Azure and custom endpoints when their id matches.

   Cache reads and cache writes are priced at their own rates where the source has them.
3. **Nothing.** If no source prices a model, its steps get no cost. Agent V shows their tokens and does not guess. A receipt shows a cost only when every step had one.

Some consequences:

- **A model nobody prices gets no estimate,** until you add a price for it.
- **Ollama is $0.** Ollama models are priced at zero, so the receipt shows `~$0`. On the Usage page a run that cost nothing counts as a task with no measurable cost.
- **An estimate is not a bill.** Your provider's invoice is the real figure.

## Spend limit per task

Settings, "Agent", "Cost" has "Spend limit per task", in whole US dollars, up to 10,000. It is off at 0, the default.

With a limit set, a task checks its spend before every model call, its [instances](/docs/instances) included. The figure is the one described above: billed where the provider reports a cost, estimated where the model has published prices, and nothing for a model with neither. When the task reaches the limit it stops before its next model call and asks "Spend limit reached", which also shows under "Needs you":

- "Allow another $N" lets this task spend the limit again. It is kept with the task, so a follow-up keeps it.
- "Stop here" ends the run. The receipt says "Stopped".

"Skip the question" under "When the agent asks a question" never answers it. An instance that finds its task over the limit stops by itself; the task asks. A follow-up to a stopped task asks again before it spends. After "Stop here", raise the limit in Settings, "Agent", "Cost" and send a follow-up to let the task go on.

## Daily and monthly budgets

Settings, "Agent", "Cost" also has "Daily budget" and "Monthly budget", across every task, in whole US dollars; 0 (the default) is off. They count the same spend as the Usage page, side calls included, in every workspace you have used, including ones you have since closed. At 80% of a budget Agent V posts a heads-up once for that day or month ("Daily budget at 84%"), and when the spend reaches it, a notice, "Daily budget reached" or "Monthly budget reached". Both go to the inbox, and to a desktop notification if those are on. Each says how much was spent and that nothing was stopped; clicking it opens the Usage page.

A budget never stops a running task; the per-task limit is what does that. "Hold new work at the budget", under the two budgets, goes one step further: once a budget is spent, new tasks, follow-ups, scheduled tasks and loops wait until the next day or month. Starting one says why and how to go on. Raising the budget past what was spent lets work through again at once.

The Usage page shows a "Budget" line above its numbers when a budget is set: today's and this month's spend against each budget, across every workspace whatever the page is scoped to, and "New work is held" while the hold is on.

## Side calls

Some model calls are not a task's own steps: compaction summaries, commit messages drafted in Changes and instructions rewritten by Structure (both on the utility model when one is set), and an MCP server's sampling requests once you allow them. Each is counted in Usage, on the task that asked when there is one and on the workspace when there is not, and it counts toward the budgets.

Commit messages are drafted when you open "Commit…", unless "Draft commit messages ahead" (Settings, "Agent", "Utility model") is on; then one is written while Changes shows uncommitted work.

## "est." and "~"

An estimated total is always marked, so you can tell it from a billed one.

| Where | Billed | Estimated |
| --- | --- | --- |
| Usage page and context meter | `$0.42` | `$0.42 est.` |
| Receipt line | `$0.42` | `~$0.42` |

Hovering an estimate explains it: "Estimated from published model rates — not a provider bill". On the receipt, the hover text is "Estimated from published prices" for an estimate and "Billed by the provider" for a billed cost.

On the Usage page, "Spend" is also marked as an estimate when some tasks in the period had no cost at all. The true total is then higher than shown. The hover says how many tasks had "no measurable cost", and the cost per task divides only by the tasks that had one.

If nothing in the period had a cost, "Spend" shows a dash and "No cost reported".

## Related

- [The task record](/docs/the-task-record) for the receipt line
- [Models and keys](/docs/models-and-keys) for providers and custom endpoints
