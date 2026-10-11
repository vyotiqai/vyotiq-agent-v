---
title: Voice mode
description: Talk with the agent on a task, choose who listens and who speaks, add your own keys, interrupt it, and approve by voice.
group: Tasks
order: 6
---

Voice mode is a spoken conversation with the agent on a task. You talk; the agent works with its usual tools and approvals; it answers out loud with a sentence or two and puts the details in the record. Talk over it at any time and it stops.

It is different from dictation. Dictation (`Ctrl+M`) types what you say into the instruction line for you to edit. Voice mode talks with the agent.

## Start and end

Open a task and press the waveform button beside the microphone on the instruction line, or press `Ctrl+Shift+M` (`Cmd+Shift+M` on macOS). "Voice mode" is also in the command palette.

The instruction line becomes the voice bar. The record stays above it. Press "End", or `Esc` twice, to go back to typing.

## The voice bar

- **The orb** shows whose turn it is. It breathes while it listens, follows your voice while you talk, turns while the agent thinks or works, and follows the agent's voice while it speaks. Each state has its own shape, and it holds still if your system asks for reduced motion.
- **The caption** shows the words it heard while you talk, and what the agent is saying while it speaks.
- **The time** since voice mode started, and **who is listening**, with a cloud for a provider or a lock for this PC.
- **Mute**, **Stop speaking**, **Stop the agent**, and **End**.

| Keys | What they do |
| --- | --- |
| `Esc` | Stop the agent speaking. Press again within two seconds to end voice mode. `Esc` never stops the run while voice mode is on. |
| `M` | Mute or unmute your microphone |
| Hold `Space` | Push to talk |

None of these act while the cursor is in a text field.

## How it behaves

- **Short answers.** One to three sentences, then the details are on screen. Ask for more ("walk me through it") and it says more.
- **No dead air.** When a slow step starts, it says a few words, such as "Running the tests." Turn this off with "Spoken progress".
- **Interrupt any time.** It stops the moment you talk. What happens to the work in progress is set by "When you talk over it": "Redirect the agent" (the default) applies what you say at its next step; "Stop the agent" cancels the run and starts on what you said; "Just stop talking" queues what you said for after the run.
- **"Stop" or "Never mind"** on their own cancel the run.
- **Approvals by voice.** When the agent needs your OK, it asks out loud ("It wants to run pnpm test. Say yes or no."). Yes allows it once; no denies it. Anything else you say goes to the agent as a message. Risky actions always need a click on the card. Turn this off with "Approve by voice".

## Choose who listens and who speaks

In Settings, "Voice", "Voice mode":

- **Listens with**: Deepgram Flux, AssemblyAI, ElevenLabs Scribe, OpenAI, or This PC (beta). Deepgram and AssemblyAI decide when you have finished talking; the others wait for a pause. This PC keeps audio on your computer and answers more slowly.
- **Speaks with**: ElevenLabs, Cartesia, OpenAI, or OpenRouter. Pick a voice and press "Preview" to hear it.
- **Automatic** uses the first provider you have a key for. With only an OpenAI key, voice mode works on OpenAI for both.
- **Speaking speed**, **Language**, **Turn ending** (how long it waits after you pause), **Push to talk only**, **Captions**, and **Sounds**.

## Keys

Voice mode uses your own keys. Add Deepgram, AssemblyAI, ElevenLabs and Cartesia keys under "Voice keys"; each is checked with the provider before it is saved, and stored encrypted like your other keys. OpenAI and OpenRouter use the keys you saved in [Models and keys](/docs/models-and-keys).

## Read an answer aloud

Every finished answer has a speaker button beside Copy. It reads the answer's short spoken summary, or its first few sentences. Press it again to stop.

## What leaves your computer

While voice mode is on, your speech goes to the listening provider and the text it speaks goes to the speaking provider, each with your key. Text that looks like a secret is removed first. Audio is never saved. See [Data and storage](/docs/data-and-storage#what-leaves-your-computer) and the [privacy policy](/privacy).

## If something goes wrong

The voice bar says what happened in plain words, with one way to fix it: "Voice settings" for a missing or rejected key, "Open mic settings" for a blocked microphone, or "Try again" after a lost connection. A lost connection is retried on its own first. If only speaking fails, voice mode keeps listening and the answers stay on screen.
