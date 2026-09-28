---
name: my-tone
description: Write in my voice for every page, UI string, post, script and email. Use whenever writing or editing copy for me or my brand, and whenever I correct your wording (then record the correction in this skill).
---

<!--
  TEMPLATE (design-level-up, Intermediate trick 12). To use it:
  1. Copy to <skills folder>/my-tone/SKILL.md (rename my-tone if you like; folder and
     name must match). Put banned-words.txt beside it, one word or phrase per line.
  2. Fill every section from real material: 5-10 things you actually wrote or said.
     An agent can draft it: give it the samples and ask it to fill this template.
  3. Delete this comment.
-->

# My tone of voice

## The voice in one line
<!-- e.g. "Plain, specific, a little dry. Talks like a friend who knows the subject." -->

## How I open and structure things
<!-- e.g. "Lead with the outcome, then the how. No throat-clearing intros." -->

## Rhythm
<!-- Sentence length, paragraph length, punctuation habits. e.g. "Mostly short sentences,
     one long one per paragraph for flow. No exclamation marks. Numbers as digits." -->

## Words I use
<!-- Recurring words, phrases, the way I name things. -->

## Words I never use
The full list is in `banned-words.txt` so tools can check it
(`python <design-level-up>/scripts/slop_check.py <files> --banned-words banned-words.txt`).
Always banned, whatever the list says: filler hype ("elevate", "unlock", "seamless",
"revolutionize", "game-changer"), and any phrase that could sit on a thousand other sites.

## Examples in my own words
<!-- Paste 5-10 real lines: headlines, intros, CTAs, a UI error message, a sign-off. -->

## Rule sets I follow (summaries, not copies of the sources)
- **ASD-STE100 Simplified Technical English** (free from asd-europe.org after a short form):
  short sentences (about 20 words for instructions, 25 for descriptions), one instruction per
  sentence, active voice, one word for one meaning, common words over clever ones.
- **Google developer documentation style guide** (developers.google.com/style): conversational
  but not frivolous, second person ("you"), present tense, sentence-case headings, the
  condition before the instruction, numbered lists for steps, no "simply" or "just".
- **Apple Style Guide** (support.apple.com/guide/applestyleguide): look up UI terms and product
  wording there instead of guessing.
<!-- Keep, drop or add rule sets. Link to the source; do not paste it in. -->

## Before returning any copy
1. Read it aloud in your head: would I say this?
2. Cut the first sentence if the second one is where it starts.
3. Replace every adjective you can with a fact or a number.
4. Nothing from the banned list; nothing that sounds like a template.

## Corrections log
When I change your wording, add a line here and follow it from then on.
<!-- 2026-09-27: "leverage" -> "use". Prefer verbs people say out loud. -->
