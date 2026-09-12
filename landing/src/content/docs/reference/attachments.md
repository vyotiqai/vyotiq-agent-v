---
title: Attachment limits and formats
description: Authoritative count, size, format, extraction, and model-capability limits for composer attachments.
section: reference
order: 4
type: reference
audience: Users attaching context
related:
  - agent/prompting-attachments
  - customize/models
  - tools/voice-dictation
---

Counts are independent by attachment kind.

| Kind | Count | Per-item raw size | Processing |
| --- | --- | --- | --- |
| Extracted file | 5 | 8 MB | Main process extracts text; retained text caps at 120,000 characters |
| Native PDF/file | Included in 5-file cap | 8 MB | Base64 file part when the model advertises native file support |
| Image | 4 | 12 MB | Image data URL; requires compatible model input |
| Audio | 2 | 16 MB | Inline audio part; requires compatible provider/model handling |

## File picker formats

The picker accepts images, PDF, plain text, Markdown/MDX, JSON/JSONC, YAML, TOML, INI, CSV/TSV, logs, SQL, HTML/XML, CSS/SCSS, JavaScript/TypeScript, Python, Ruby, Go, Rust, Java, Kotlin, Swift, C/C++, C#, PHP, shell scripts, PowerShell, patch/diff, WAV, MP3, and M4A. Text MIME types are also accepted.

Acceptance by the picker does not guarantee successful extraction. The main process returns a specific error for unsupported or unreadable content.

## Audio formats

Audio detection accepts WAV, MP3/MPEG, M4A/MP4, WebM, and Ogg by supported MIME or extension.

## Overflow behavior

When the cap has already been reached, the composer reports the maximum. If a multi-select exceeds remaining slots, only available items are considered and a limit message is shown. Oversized or unreadable items are skipped; accepted items remain attached.

## Persistence

Attachments can persist across composer remounts for the selected workspace. They are still part of the next prompt, so remove stale attachments before switching tasks.

## Provider boundary

The selected model's catalog metadata determines whether images, native files, audio, tools, and thinking are supported. Extracted text can work when native-file support is absent, but PDFs still have the same 8 MB raw cap.
