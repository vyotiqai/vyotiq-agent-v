---
name: repo-onboarding
description: >-
  Produce a guided tour of an unfamiliar repository: what it does, how it is structured, how to run and test it, and where to make a first change. Use when opening a new project or asked how a codebase works.
metadata:
  version: "1.0.0"
---

# Repo onboarding

## Instructions

Start from what the project is for. Read the README, package manifest, and entry points before forming any opinion about the architecture.

Establish how to run it: install, build, dev, test, and lint commands, taken from the actual scripts and config rather than convention. Run the test suite to see whether it is green before you describe it as such.

Map the layout: the handful of directories that matter, what lives in each, and how a request or command flows through them. Name real files. Skip directories that are noise.

Identify the conventions a newcomer would otherwise violate: error handling, module boundaries, state management, naming, test placement. Cite an example file for each.

Point at a good first change: something small, real, and covered by tests. Explain why it is a safe entry point.

Say plainly what you could not determine and where the documentation is stale or contradicts the code.

## When to use

Use when opening an unfamiliar repository or asked how a codebase is organised and how to start working in it.

## When not to use

The user asks how one specific mechanism works: use explain-code.

The user already knows the project and wants a change made: do that instead.

## Output

Return purpose, run and test commands with their verified status, a directory map, conventions with example files, a suggested first change, and open questions.

## Done when

Run and test commands were executed, not just quoted.

The directory map names real paths.

Each convention cites a file that demonstrates it.

Gaps and stale docs are stated rather than smoothed over.

## Avoid

Describing the architecture from directory names without reading the code.

Claiming the test suite passes without running it.

Producing a file listing instead of an explanation.
