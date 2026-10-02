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
- **Days:** "7 days" or "30 days".

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

Click a task in "Unchecked" to open it.

## How cost is worked out

For each step of a run, Agent V uses the first of these that applies:

1. **Reported by the provider.** Some providers return the cost with their response. Agent V shows that amount as billed.
2. **Estimated.** Otherwise Agent V multiplies the tokens by the model's published USD rates, from a price table built into the app. Cache reads and cache writes are priced at their own rates where the provider publishes them.
3. **Nothing.** If a model is not in the table, its steps get no cost. Agent V shows their tokens and does not guess. A receipt shows a cost only when every step had one.

Some consequences:

- **Unknown models get no estimate.** That includes every model on a custom OpenAI-compatible endpoint, unless the endpoint reports a cost itself.
- **Ollama is $0.** Ollama models are priced at zero, so the receipt shows `~$0`. On the Usage page a run that cost nothing counts as a task with no measurable cost.
- **An estimate is not a bill.** Your provider's invoice is the real figure.

## Spend limit per task

Settings, "Agent", "Runs" has "Spend limit per task", in whole US dollars, up to 10,000. It is off at 0, the default.

With a limit set, a task checks its spend before every model call, its [instances](/docs/instances) included. The figure is the one described above: billed where the provider reports a cost, estimated where the model has published prices, and nothing for a model with neither. When the task reaches the limit it stops before its next model call and asks "Spend limit reached", which also shows under "Needs you":

- "Allow another $N" lets this task spend the limit again. It is kept with the task, so a follow-up keeps it.
- "Stop here" ends the run. The receipt says "Stopped".

"Skip the question" in Unattended mode never answers it. An instance that finds its task over the limit stops by itself; the task asks. A follow-up to a stopped task asks again before it spends. After "Stop here", raise the limit in Settings, "Agent", "Runs" and send a follow-up to let the task go on.

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
