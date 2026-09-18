---
name: pr-review-reply
description: >-
  Work through unresolved review comments on a pull request: read each thread, make the code change it asks for, and draft a reply. Use when asked to address, respond to, or catch up on PR feedback.
metadata:
  version: "1.0.0"
---

# PR review reply

## Instructions

List the unresolved review threads on the pull request with their file, line, author, and full comment body. Include replies, since a thread often moves on from its first message.

Group the threads: changes the reviewer asked for, questions to answer, and suggestions that are arguable. Handle them in that order.

For a requested change, make it and point the reply at the resulting commit. For a question, answer from the code rather than from memory. For a suggestion you disagree with, say so plainly with the reason and leave the decision to the reviewer.

Re-read the diff after the changes to confirm you have not broken an unrelated thread's assumption, and run the tests the touched code has.

Draft the replies and show them to the user. Do not post them, resolve threads, or push until the user says to.

## When to use

Use when asked to address, respond to, or work through review comments on a pull request.

## When not to use

The user wants you to review someone else's code: use review-code.

The pull request has no review feedback yet: there is nothing to answer.

## Output

Return each thread, what you changed or why you did not, the drafted reply, and the test results.

## Done when

Every unresolved thread is accounted for, including the ones you declined.

Each code change is traceable to the comment that asked for it.

Replies are drafted for the user to send, not posted.

## Avoid

Posting replies, resolving threads, or pushing without being asked.

Agreeing to a change you believe is wrong instead of saying so.

Answering a question about behaviour without reading the code.
