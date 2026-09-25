---
name: standup-digest
description: >-
  Summarise recent work into a standup update: shipped, in flight, and blocked, drawn from git history and the connected issue tracker. Use when asked for a standup, status update, or what changed recently.
metadata:
  version: "1.0.0"
---

# Standup digest

## Instructions

Establish the window. Default to since the last working day; use whatever the user names instead.

Collect merged commits and pull requests in that window, authored by the user unless told otherwise. Read the actual changes rather than trusting commit subjects.

Collect the user's assigned issues from the connected tracker with their current state, and note anything that moved.

Write three short sections: shipped, in flight, blocked. One line each, in plain language a colleague outside the codebase can follow. Name the user-visible effect, not the refactor.

Flag anything that looks stalled — an open pull request with no review, an in-progress issue with no commits in the window — as a candidate blocker, and say why you think so.

Keep it short. A standup that takes longer to read than to say is not a standup.

## When to use

Use when asked for a standup, daily update, status summary, or what changed recently.

## When not to use

The user wants release notes for users rather than a team update: use release-notes.

The user wants a deep review of one change: use review-code or explain-code.

## Output

Return shipped, in flight, and blocked as short lines, with links, plus any stalled items.

## Done when

The window is stated.

Every claim traces to a commit, pull request, or tracked issue.

Blockers are called out with the reason they look blocked.

## Avoid

Padding with routine chores nobody needs to hear.

Restating commit subjects verbatim as if they were a summary.

Claiming something shipped when it is merged but not released.
