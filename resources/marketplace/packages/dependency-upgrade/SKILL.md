---
name: dependency-upgrade
description: >-
  Upgrade project dependencies safely: check what is outdated, read the changelogs, upgrade in small batches, and verify each step. Use when asked to update, bump, or upgrade packages.
metadata:
  version: "1.0.0"
---

# Dependency upgrade

## Instructions

List what is outdated with current, wanted, and latest versions, and separate patch, minor, and major.

Read the changelog or release notes for anything crossing a minor or major boundary. Report breaking changes before making them. Do not upgrade a major version silently.

Upgrade in batches: patches together, then minors one group at a time, then each major on its own. Run the test suite and the build after every batch so a failure names its own cause.

When a batch fails, stop and diagnose rather than continuing. Report whether the failure is the dependency's behaviour change or the project's use of it.

Check the lockfile is consistent and that no peer-dependency warnings were introduced.

Report what moved, what you deliberately left behind, and why. Leaving a pinned dependency alone with a stated reason is a valid outcome.

## When to use

Use when asked to upgrade, update, or bump dependencies, or to check what is outdated.

## When not to use

A single dependency is causing a specific bug: use fix-bug.

The user wants a vulnerability audit specifically: run the audit and report it rather than upgrading everything.

## Output

Return the upgrade table, breaking changes found, what was upgraded and verified, and what was left pinned with the reason.

## Done when

Majors were surfaced with their breaking changes before being applied.

Tests and build ran after each batch, not only at the end.

Anything left behind has a stated reason.

## Avoid

Upgrading everything at once so a failure cannot be attributed.

Applying a major version bump without reading its changelog.

Editing the lockfile by hand to force a resolution.
