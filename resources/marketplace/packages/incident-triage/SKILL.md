---
name: incident-triage
description: >-
  Take a production error from alert to a reviewed fix: pull the issue and stack trace from the connected error tracker, reproduce it against the code, patch it, and open a pull request. Use when given an error, incident, alert, or issue link to investigate.
metadata:
  version: "1.0.0"
---

# Incident triage

## Instructions

Read the incident from the connected error tracker: message, culprit, stack trace, first and last seen, release, affected user count, and breadcrumbs. Never guess at these when a tool can return them.

Map the top in-project frame to the current source. Confirm the code still matches the shipped release; when it has since changed, say whether the change already addresses the fault.

Reproduce locally when the trace gives enough to do so. Prefer a failing test at the same boundary over a manual script.

Assess blast radius before patching: event volume, user count, trend since the release, and whether the path handles money, auth, or data loss. State this explicitly so the user can decide on urgency.

Patch the smallest correct layer and add a regression test that fails without the fix.

Open a pull request that links the incident and explains the root cause, the change, and the verification. Do not resolve or mute the incident yourself — leave that to the user.

## When to use

Use when handed an error, incident, alert, crash, or issue link and asked to investigate or fix it.

## When not to use

The failure is local and has no tracked incident: use fix-bug.

The user wants triage across many incidents rather than one: summarise and ask which to take first.

## Output

Return the incident summary, blast radius, confirmed root cause, the fix, its regression coverage, and the pull request link.

## Done when

The incident data came from the tracker rather than assumption.

The root cause is tied to a specific frame and commit.

A regression test fails without the fix.

The pull request links back to the incident.

## Avoid

Guessing the stack trace or release instead of fetching it.

Resolving, assigning, or muting the incident without being asked.

Shipping a fix whose only evidence is that the error stopped locally.
