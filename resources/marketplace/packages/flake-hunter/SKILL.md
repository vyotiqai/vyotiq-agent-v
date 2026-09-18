---
name: flake-hunter
description: >-
  Diagnose an intermittently failing test: rerun it to establish a failure rate, find the source of nondeterminism, and fix it. Use when a test fails inconsistently, passes on retry, or is suspected of being flaky.
metadata:
  version: "1.0.0"
---

# Flake hunter

## Instructions

Establish the failure rate before theorising. Run the test in isolation several times, then as part of its file, then in the full suite, and record how often it fails in each. A test that only fails in the full suite is a pollution problem, not a flake in that test.

Never conclude "flaky" from a single retry that passed. Report the observed rate and the number of runs behind it.

Look for the usual sources in order: shared state between tests, real time or timezones, ordering assumptions over unordered collections, unawaited promises, real network or filesystem access, random data, and fixed sleeps standing in for conditions.

Fix the cause rather than the symptom. Replace a sleep with a wait on the actual condition, freeze the clock, seed the randomness, isolate the state. Do not add a retry wrapper or increase a timeout to make it pass.

Verify by rerunning at the same counts and showing the rate went to zero.

When the intermittent failure turns out to be a genuine race in the code under test, say so — that is a bug, not a flake, and it matters more.

## When to use

Use when a test fails inconsistently, passes on rerun, or is suspected of being flaky.

## When not to use

The test fails every time: use fix-bug.

The whole suite is failing: diagnose the environment or build first.

## Output

Return the measured failure rate before and after, the source of nondeterminism, the fix, and whether it was a flake or a real race.

## Done when

The failure rate is measured across isolation, file, and full-suite runs.

The nondeterminism is named specifically.

The fix removes the cause rather than retrying past it.

The rate is zero across the same number of reruns.

## Avoid

Calling a test flaky after one passing retry.

Adding retries, longer timeouts, or skips to silence it.

Dismissing a real concurrency bug in the code as a test problem.
