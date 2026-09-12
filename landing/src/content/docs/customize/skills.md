---
title: Skills
description: Create personal or project SKILL.md packages, understand discovery precedence, and load them in a run.
section: customize
order: 5
type: guide
audience: Workflow authors
related:
  - customize/slash-commands
  - customize/rules
  - reference/tools
---

A Skill is a directory containing SKILL.md. Its frontmatter names and describes the workflow; its body supplies instructions the agent can load when the task matches.

## Locations and precedence

Agent V discovers:

1. Project skills in {workspace}/.vyotiq/skills/<name>/SKILL.md.
1. Compatible project skills in {workspace}/.cursor/skills/<name>/SKILL.md.
1. Personal skills in ~/.vyotiq/skills/<name>/SKILL.md.

Project sources are scanned before personal sources. When names collide, the first discovered name wins. Discovery is bounded to 64 local skills.

Bundled Marketplace skills that can be installed without a registry include the workflow pack (`implement-feature`, `fix-bug`, `review-code`, `write-tests`, `explain-code`, `create-skill`) plus `frontend-design`, `accessibility`, `api-design`, and `goal`. Install them from Marketplace → Browse or Manage; they appear without an app restart.

## Create a skill

Use Marketplace → Manage → **Skills** or /create-skill. /create-skill creates under {workspace}/.vyotiq/skills/ by default; /create-skill personal targets the personal scope.

A minimal file is:

```yaml
---
name: verify-release
description: Verify a built release and report concrete artifacts.
---
```

Use the repository's real release command. Confirm the output path on disk.

Never claim packaging succeeded from command exit alone.

Keep the description specific enough for selection. Put reusable instructions in the body and supporting files inside the same skill directory.

## Use a skill

The Skill built-in loads an enabled skill or a relative file under that skill. Skill-derived slash commands can also appear in the composer. A skill provides instructions; it does not bypass mode policy, tool approval, path guards, or higher-priority constraints.

## Refresh behavior

Marketplace editing clears the local skill cache, and filesystem fingerprints refresh discovery. New or changed skills appear without restarting the application. If a skill is missing, verify the file is named SKILL.md, the frontmatter parses, the directory sits under one of the discovered locations, and another source did not already claim the same name.
