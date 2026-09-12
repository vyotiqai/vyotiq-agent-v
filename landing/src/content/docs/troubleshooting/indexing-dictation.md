---
title: Indexing and dictation issues
description: Recover from reindex failures, search gaps, and voice setup problems.
section: troubleshooting
order: 5
type: troubleshooting
audience: Search and voice users
related:
  - tools/indexing
  - tools/voice-dictation
  - reference/storage
---

## Codebase search returns nothing

Open Settings → Indexing. Confirm Enable codebase index is on. When off, `codebase_search` is removed from the tool catalog.

Read Index status:

- syncing: inspect file progress and wait for the first pass to finish.
- ready: the index is built; search results cover production source only.
- error: preserve the message before changing settings.

Use Reindex workspace once after fixing the cause. grep and glob keep working without the index through a live scan.

## Reindex fails

Confirm the workspace folder exists and is readable, and that disk space is available. The index lives under app data, not the project tree.

## Dictation mic or transcription fails

Open [Settings → Voice](/docs/tools/voice-dictation) and confirm the selected Dictation engine:

- **OpenAI** needs a saved **OpenAI** key.
- **OpenRouter** needs a saved **OpenRouter** key.
- **Local** needs an installed Whisper model.

The engine is read on mic stop. Installation alone does not switch to **Local**.

## Local Whisper fails

Check the model card for download, load, or error status. Try Unload before reloading. Use Delete … cache only when you intend to redownload required model files.

The supported local IDs are whisper-tiny.en and whisper-small.en. **Local** transcription is English.

## Collect evidence

Record app version, platform, dictation engine, index phase, progress text, and exact error. Do not delete indexes or caches before capturing the error unless the recovery step specifically requires it.
