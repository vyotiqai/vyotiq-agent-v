---
title: Usage and cost
description: What the Usage page shows, how Agent V works out the cost of a run, and what "est." and "~" mean.
group: Review and ship
order: 3
---

Agent V counts the tokens every run uses and, where it can, what they cost. You see this per run on the receipt, and across runs on the Usage page.

## The Usage page

Open it with "Usage" in the navigator, or the "Usage" link on Home. Two controls at the top set what it covers:

- **Workspaces:** "All workspaces", or one open workspace.
- **Days:** "7 days" or "30 days".

### The four numbers

| Stat | What it counts |
| --- | --- |
| Tasks | Runs in the period, compared with the period before |
| Tokens | Input and output tokens, with the share served from cache |
| Spend | Cost for the period, and the cost per task |
| Finished | The share of runs that finished, with how many failed, stopped or are still running |

### The charts

| Chart | What it shows |
| --- | --- |
| "Tasks per day" | How many runs each day |
| "Spend per day" / "Tokens per day" | Switch between cost and tokens per day |
| "Model mix" | Which models the runs used, by output tokens |
| "Tool failures" | Tools that failed, out of all tool calls |
| "Unchecked" | Runs with "edits with no passing check after". "Worth a test run before you commit." |

Click a task in "Unchecked" to open it.

## How cost is worked out

For each step of a run, Agent V uses the first of these that applies:

1. **Reported by the provider.** Some providers return the cost with their response. Agent V shows that amount as billed.
2. **Estimated.** Otherwise Agent V multiplies the tokens by the model's published USD rates, from a price table built into the app. Cache reads and cache writes are priced at their own rates where the provider publishes them.
3. **Nothing.** If the model is not in the table, the run gets no cost. Agent V shows its tokens and does not guess.

Some consequences:

- **Unknown models get no cost.** That includes every model on a custom OpenAI-compatible endpoint.
- **Ollama is $0.** Ollama models are priced at zero.
- **An estimate is not a bill.** Your provider's invoice is the real figure.

## "est." and "~"

An estimated cost is always marked, so you can tell it from a billed one.

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
