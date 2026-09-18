---
name: release-notes
description: >-
  Turn merged work since the last release into user-facing release notes, grouped by what changed for the user. Use when asked for release notes, a changelog entry, or what is in this release.
metadata:
  version: "1.0.0"
---

# Release notes

## Instructions

Find the last release tag and collect every commit and merged pull request since it. When there is no tag, ask what range to cover.

Read the changes, not just the subjects. A commit titled "fix types" may be the user-visible bug fix; a commit titled "add feature" may be a no-op behind a flag.

Group by what it means to someone using the product: new, improved, fixed. Drop pure refactors, test changes, and internal chores unless they change behaviour or performance a user would notice.

Write each line in the user's vocabulary, not the codebase's. Say what someone can now do or no longer has to work around.

Call out breaking changes and required migration steps in their own section at the top, with the exact action needed.

Note anything merged but behind a flag as not yet released, rather than listing it as shipped.

## When to use

Use when asked for release notes, a changelog entry, or a summary of what is in a release.

## When not to use

The audience is the team rather than users: use standup-digest.

The user wants a commit log: give them the log rather than notes.

## Output

Return breaking changes first, then new, improved, and fixed, with flagged-but-unreleased items marked.

## Done when

Every entry traces to merged work in the range.

Breaking changes name the exact migration step.

Internal-only churn is excluded, and flag-gated work is marked as unreleased.

## Avoid

Restating commit subjects as release notes.

Listing refactors and dependency bumps users cannot observe.

Describing something as shipped while it is still behind a flag.
