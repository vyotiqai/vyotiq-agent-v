---
title: Voice dictation
description: Choose OpenAI, OpenRouter, or Local transcription and manage the two supported Whisper caches.
section: tools
order: 8
type: guide
audience: Voice users
related:
  - troubleshooting/indexing-dictation
  - customize/providers
  - reference/settings
---

Dictation transcribes microphone audio into the composer. Configure it under [Settings → Voice](/docs/tools/voice-dictation).

## Choose an engine

Dictation engine offers:

- **OpenAI**: uses gpt-transcribe and the saved **OpenAI** key.
- **OpenRouter**: uses gpt-transcribe through **OpenRouter** and its saved key.
- **Local**: runs English Whisper inference on this machine.

The engine is read each time the microphone stops, so changing it does not require a restart. The mic does not inherently require an **OpenAI** key; its requirement follows the selected engine.

Waveform chooses the listening visualizer in the composer: Bars, Dots, Line, or Mirror. It does not change transcription.

## Use Local

**Local** remains disabled until at least one model is installed:

- Whisper Tiny: Fast, English, about 41 MB.
- Whisper Small: Recommended, English, about 249 MB.

Use Install Whisper Tiny or Install Whisper Small. Installation does not switch Dictation engine to **Local** by itself.

When a model is loaded, Unload Whisper Tiny/Small releases its runtime memory. Delete Whisper Tiny/Small cache removes the downloaded files. The UI can mark a model as recommended for the current machine, but never installs it automatically.

## Dictate

Use the composer microphone or Ctrl+M / ⌘M. Start recording, speak, then stop. The transcript is inserted into the composer for review before send.

Always review names, code identifiers, paths, and commands. Transcription output is user prompt text; it is not executed until you send it and the selected mode permits the resulting work.

## Privacy boundary

**OpenAI** and **OpenRouter** receive the recorded audio for transcription. **Local** keeps inference on this machine after model download. **Local** model files are cached under app user data.

For microphone, missing-key, download, load, or model errors, use Indexing and dictation issues.
