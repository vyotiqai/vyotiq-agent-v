---
title: Privacy and data storage
description: What Agent V writes to disk, what stays on your machine, and what leaves it only if you opt in.
section: concepts
order: 4
type: concept
audience: All users and auditors
related:
  - reference/storage
  - concepts/security
  - tools/voice-dictation
---

Everything Agent V writes lives in two places: the app-data directory (`%APPDATA%\vyotiq` on Windows) and a `.vyotiq` folder inside each workspace. There is no separate database — state is plain JSON and markdown files you can open in any editor.

## Stays local

- **Transcripts, events, run artifacts, receipts.** Written under app data as plain files.
- **Memory, rules, and skills.** Stored in the workspace `.vyotiq` folder as markdown. Agent V does not sync or upload them.
- **Model requests.** By default Agent V talks to a local Ollama server (`http://127.0.0.1:11434`), so your code and prompts stay on your machine. If you configure a cloud provider instead, requests go to that provider — you choose this in Settings → Providers.
- **Dictation.** Voice input runs a local Whisper model (ONNX) in a separate utility process. Recorded audio stays on your machine.
- **Notifications and inbox.** Stored locally in app data.

## Opt-in only

- **Crash and error reports.** The **Share crash & error reports** setting (Settings → General) is off by default. When enabled, reports go to a Sentry project you configure with your own DSN.

## Secrets

API keys are stored with the operating system's secure storage (Electron safeStorage), not in plain settings files.

## Logs

Agent V always writes rotating local logs under app data. Open them from **Settings → General → Open logs folder**.

## Uninstall

The Windows uninstaller does not delete the app-data directory. After uninstalling, delete `%APPDATA%\vyotiq` yourself if you want a clean removal.

## Privacy policy

The published privacy policy lives at [vyotiq.com/privacy](https://vyotiq.com/privacy).
