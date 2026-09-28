# Voice — audit and redesign mockups

Mockups of a redesigned dictation experience, on the renderer's own stack:
React 19, TypeScript, Tailwind v4 CSS-first, the real `--vy-*` tokens and
skins, and the **real primitives** from `src/renderer/src/lib/ui` (Button,
IconButton, Keys, Segmented, Switch, ProgressBar, FormGroup/FormRow,
StatusGlyph, Tabs…), imported rather than copied. The task header, record body
and Settings index are the shipped components too.

```sh
pnpm redesign:voice     # http://localhost:5199
```

The viewer picks the screen, the skin (or **all** five), light or dark, and
the window size. One window at 1:1 for a screenshot:
`?s=<screen>&skin=<skin>&theme=<light|dark>&size=<1440|1920|1280>&bare=1`.
The level meter scrolls in the viewer and holds still in a `bare=1` frame.

Start with **Audit · today**. It renders the shipped `DictationSession` and
`DictationErrorBanner` next to the 14 findings. Then read **Parts sheet**:
every state of the new take strip at 1:1, a take's life as a diagram, the
mic's four faces and the keys.

## Audit: what dictation is today

Voice in Vyotiq is **dictation**: speech becomes text in a brief or an
instruction. It is not a spoken conversation. There is no text-to-speech
anywhere in the app. These are the surfaces:

- The mic on the instruction line, on the New task brief and in edit-and-rerun (`Composer.tsx`, three copies).
- `Ctrl+M` and the palette command.
- The live strip and the error banner (`DictationSessionStrip.tsx`).
- The capture logic (`useComposerDictation.ts`, 688 lines).
- Settings → Voice (`VoiceSection.tsx`).
- The engines in `src/main/dictation`: OpenAI/OpenRouter `gpt-transcribe`, and local Whisper Tiny/Small in ONNX.

| # | Area | Finding |
| - | --- | --- |
| 1 | Flow | **The field disappears.** On the instruction line the waveform *replaces* the input, so you dictate into text you can't see. The brief puts it above the input, and so does edit-and-rerun. That makes three layouts for one control. |
| 2 | Flow | **Blind until the end.** No words appear until you stop. A take may run for an hour (`MAX_DICTATION_MS`). |
| 3 | Flow | **■ and × side by side.** ■ inserts the text and × discards the take, with no confirm and no undo. Esc also discards. |
| 4 | Flow | **A frozen "Transcribing".** The timer stops, the bars freeze grey and the mic spins. There is no progress indicator. |
| 5 | Flow | **Checked after the press.** Every press reads settings and model status over IPC before the mic opens, so "Starting…" loses the first words. |
| 6 | Errors | **Errors are guessed.** The Settings link is chosen by running a regex over the error text (`/Voice/`, `/API key/`), and raw provider text reaches the user. |
| 7 | Errors | **A failed take is lost.** The audio isn't kept and there's no Retry. |
| 8 | Errors | **Blocked mic, dead end.** "Microphone permission denied" gives no route to the Windows switch. |
| 9 | Errors | **Silence is recorded.** With a muted or wrong device you only find out at the end ("empty transcript"). |
| 10 | Flow | **The wrong fact is repeated.** "OpenAI ·" appears on every take, but the mic never says that the audio leaves the machine. |
| 11 | Settings | **Local is disabled until a model is installed**, and the install rows are further down the page. "In use" shows on a local model while OpenAI is selected. |
| 12 | Settings | **The default fails.** The engine defaults to OpenAI, so the first press fails for anyone without an OpenAI key. |
| 13 | Settings | **The basics are missing:** microphone choice, level test, language, hold-to-talk. Meanwhile there are four waveform styles. |
| 14 | Code | **One control, written three times** in `Composer.tsx`, and the copies have drifted. |

## The redesign

### One idea: a *take*, and the field never goes away

A take is one stretch of dictation, from the mic opening to the words
landing. Its words appear **in the field, at the caret, as you speak**.
Settled words are normal text and the unsettled tail is `text-tertiary`. A
32px **take strip** under the field shows five things:

- what the mic hears, as a rolling level meter
- how long the take has run
- where the audio goes (`This PC` 🔒 or `OpenAI` ☁)
- Discard
- Insert

The strip sits in the same place, with the same shape, on every surface. On
the line it hangs under the field on the field's left edge. On the brief it
takes the place of the box's bottom row.

### States (all in the Parts sheet)

| State | What you see | Way out |
| --- | --- | --- |
| Opening | Hollow dot, flat meter, "Opening the mic" | — (the engine is checked *before* the press, so this is short) |
| Listening | Accent dot, rolling meter, time, engine | **Insert ↵** · Send/Queue `Ctrl ↵` · Discard `Esc` |
| Near the cap | Time left in warning, last minute only | same |
| Hold to talk | "Release Ctrl M to insert" | let go |
| Nothing heard | After 4 s: "Nothing heard from *device*" | Change mic · Discard |
| Finishing | The take's meter frozen quiet, progress where the engine reports it | Discard |
| Inserted | Added words tinted `accent-soft` for 5 s; "17 words inserted" | Undo `Ctrl Z` |
| Discarded | "Discarded a 0:19 take" for 8 s | **Restore** |
| Failed | The reason in plain words; "1:24 kept" | **Retry** · Try the other engine · the fix (Providers) · Discard |

An engine that can't stream words shows a waveform marker at the caret
instead. It holds the place where the words will land.

### First use and blocked mic, at the mic

- **Not set up**: the mic carries the one accent "needs you" dot. Pressing it opens *Dictate with*: This PC (Whisper Small, recommended, Install), OpenAI (Use), OpenRouter (Add key). A download shows progress in the row, and the mic opens by itself when the model is ready.
- **Blocked**: the mic becomes `micSlash` in warning. Its popover draws the two Windows switches, shows which one is off, and links straight to them.

### Settings → Voice

The page keeps the real `FormGroup` / `FormRow` grammar and marks only
changed rows:

- **Dictation**
  - **Runs on**: This PC / OpenAI / OpenRouter. It is never disabled, and it states where the audio goes. A missing key is flagged on this row, with **Add key**.
  - **Model**: shown only for This PC. Each row is a radio with size on disk, memory when loaded, and install progress in the row.
  - **Language**: English only on This PC; auto-detect on the cloud engines.
- **Microphone**
  - **Input**: a device picker with a live level meter.
- **Controls**
  - **Shortcut**
  - **Hold to talk**
  - **Enter ends a take by**: Inserting / Sending
- **Removed**: the Waveform style setting. There is now one meter.

### Said once

| Fact | Its one home | Removed from |
| --- | --- | --- |
| Where audio goes | Strip's engine token; mic tooltip; Settings row hint | Every take's "OpenAI ·" prefix |
| Take length | Strip | The caret marker (it shows only a glyph) |
| How to fix a failure | The failed strip's own button | Regex-picked banner link |

## Decisions I made that are yours to overrule

These change the flow rather than the look, so they need your call before porting:

1. **Live words while speaking.** Local Whisper can do this by re-transcribing a rolling window every ~2 s. Cloud needs OpenAI's streaming or realtime transcription, or chunked uploads. Where an engine can't, the caret marker is the fallback, so the design degrades cleanly. This is the biggest engine-side cost.
2. **Esc discards but can be undone.** It is still one key, but for 8 s it can be restored. The alternative is Esc = stop and keep.
3. **Hold-to-talk** is on the same chord as tap-to-toggle (Ctrl M held for over 300 ms).
4. **Default engine**: when nothing is set up, the mic opens *Dictate with* instead of failing on the OpenAI default.
5. **Waveform styles removed.**
6. **Not a conversational voice mode.** No spoken replies. That fits "never chatbot-like", and it can be revisited separately.

## Porting notes (when approved)

- One `DictationTake` component and one `useTake` hook replace the three mic blocks in `Composer.tsx`, `DictationSessionStrip.tsx`, and most of `useComposerDictation.ts`.
- Errors become typed codes from main (`no_key`, `rejected_key`, `offline`, `model_missing`, `empty`, `too_long`) instead of regex over message text.
- Keep the recorded Blob until Insert or Discard expires, so Retry and Restore cost nothing.
- Preflight moves to mount and settings-change, with the result cached. The press then only opens the mic.
- Settings: `dictation.deviceId`, `dictation.language`, `dictation.holdToTalk`, `dictation.enterAction`; drop `waveformStyle` (migrate by ignoring it).
- Tests: `composer.dictation.test.tsx` and `tests/gui-e2e/dictation.spec.ts` key on `data-dictation-session`; the new strip uses `data-take=<state>`.

## Icons to add to `src/renderer/src/lib/icons`

`micSlash` (MicrophoneSlash) and `cloud` (Cloud). They are proposed in `src/lib/icons.tsx`, which wraps the real allowlist.

## Where it lives and why it cannot ship

`src/redesign/voice/` is outside `tsconfig.web.json`, outside the renderer's
Tailwind scan, and excluded from electron-builder (`src/**`). Type-check it
with `node_modules/.bin/tsc -p src/redesign/voice/tsconfig.json`. `eslint
src/redesign/voice` passes.
