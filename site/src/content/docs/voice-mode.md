---
title: Voice mode
description: Talk with the agent on a task, choose who listens and who speaks, add your own keys, interrupt it, and approve by voice.
group: Tasks
order: 6
---

Voice mode is a spoken conversation with Agent V on a task. You talk, and a fast voice model answers in a second or two. When you ask for something to be done or checked, it says so and hands the work to the agent, which works with its usual tools and approvals; when the agent finishes, its result is read out and the details are in the record. Talk over it at any time and it stops talking. The work carries on.

It is different from dictation. Dictation types what you say into the instruction line for you to edit: press `Ctrl+M`, or hold `Space` in an empty instruction line and let go when you're done. Voice mode talks with you.

## Start and end

Open a task and press the waveform button beside the microphone on the instruction line, or press `Ctrl+Shift+M` (`Cmd+Shift+M` on macOS). "Voice mode" is also in the command palette.

The voice view opens over the task: the conversation so far, what it's doing now, and its controls. Press "Show the task" to see the record; the voice bar in the instruction line (or a small pill) brings the view back. Press "End", or `Esc` twice, to go back to typing.

If the task is already working when you start, voice mode follows that work too: its result is read out, and "stop" or "is it done?" reach it.

You can also start on **New task**. Press the waveform button in the brief and say what you want done: that starts the task, with any checks, folders and attachments you already added, and the conversation carries on in it.

## The voice view

- **The orb** shows whose turn it is. It breathes while it listens, follows your voice while you talk, turns faster while it thinks or the agent works, and moves with the voice while it speaks. It goes grey when muted, and holds still if your system asks for reduced motion.
- **The conversation**: what you said and what it said. Your words appear as you say them when the listening provider streams them.
- **Each piece of work it handed over**, as one line with its steps as they happen, then how it ended and the agent's answer. When the agent needs your OK or asks a question, you can answer right there (or out loud), including Always allow where the card offers it. Risky actions still need the card on the task.
- **The time** since voice mode started, and **which models hear and speak**.
- **Mute**, **Stop speaking**, **Stop the task** (while it works), and **End**.

### Make it yours

In Settings, "Voice", "Voice mode", "Voice view":

- **Layout**: **Conversation** (the conversation fills the view, with the orb in the bar under it), **Orb** (a large orb with what's happening now under it; the conversation opens beside it), or **Split** (the conversation on the left, the task's steps and result on the right).
- **Orb**: Glow, Pearl, Aura, Wire, Cloud, Bubble, Halftone, Plasma, Contour, Liquid, or Simple. A small preview shows each one moving. They take their colours from your theme. Simple is a drawn orb that uses no graphics card.

| Keys | What they do |
| --- | --- |
| `Esc` | Stop the agent speaking. Press again within two seconds to end voice mode. `Esc` never stops the run while voice mode is on. |
| `M` | Mute or unmute your microphone |
| Hold `Space` | Push to talk |

None of these act while the cursor is in a text field.

## How it behaves

- **It waits for you to finish.** A turn ends when you pause (about 1.3 seconds; change it with "Turn ending"). Words you add before it starts answering join the same turn.
- **Short answers.** One to three sentences. Ask "what did it find?" and it answers from what the agent reported.
- **Work goes to the agent.** "Run the tests", "which branch am I on?": it says "On it." and the agent does the work. Ask for more while it works and that joins the work in progress.
- **No dead air.** When a slow step starts, it says a few words, such as "Running the tests." Turn this off with "Spoken progress".
- **Interrupt any time.** It stops talking the moment you talk, and answers what you said. Talking never cancels the agent's work.
- **"Stop" or "Never mind"** on their own stop the agent's work.
- **Approvals by voice.** When the agent needs your OK, it asks out loud ("It wants to run pnpm test. Say yes or no."). Yes allows it once and no denies it, and it says which out loud; "always allow" allows it and stops asking for that command or tool in this workspace, exactly as the card's Always allow does (it's offered out loud only where the card offers it). Anything else you say goes to the agent as a message. Risky actions always need a click on the card. Turn this off with "Approve by voice".

## Choose who listens and who speaks

In Settings, "Voice", "Voice mode":

- **Listens with**: Deepgram Flux, AssemblyAI, ElevenLabs Scribe, OpenAI, OpenRouter, or This PC (beta). Deepgram and AssemblyAI decide when you have finished talking; the others wait for a pause. OpenRouter and This PC hear each turn only once you pause, so there are no live captions and replies come more slowly; This PC keeps audio on your computer.
- **Speaks with**: ElevenLabs, Cartesia, OpenAI, or OpenRouter. Pick a voice and press "Preview" to hear it. Speaking models differ a lot in how soon they start: ElevenLabs Flash and Kokoro start in under a second.
- **Answers with**: the voice model that talks with you. The default is Claude Haiku 5.5 through OpenRouter; any model you have a key for works. Without one, what you say goes straight to the agent.
- **Automatic** uses the first provider you have a key for. With only an OpenAI key, voice mode works on OpenAI for both; with only an OpenRouter key, on OpenRouter for both.
- **Speaking speed**, **Language** (English unless you pick another, or "Detect"), **Turn ending** (how long it waits after you pause), **Push to talk only**, **Captions** (they hide the words, never the work), and **Sounds**.

## Keys

Voice mode uses your own keys. Add Deepgram, AssemblyAI, ElevenLabs and Cartesia keys under "Voice keys"; each is checked with the provider before it is saved, and stored encrypted like your other keys. OpenAI and OpenRouter use the keys you saved in [Models and keys](/docs/models-and-keys).

## Read an answer aloud

Every finished answer has a speaker button beside Copy. It reads the answer's short spoken summary, or its first few sentences. Press it again to stop.

## What leaves your computer

While voice mode is on, your speech goes to the listening provider, the words it heard go to the voice model with the recent conversation and the task's messages and answers so far (not its tool output or files), and the text it speaks goes to the speaking provider, each with your key. Text that looks like a secret is removed before it's spoken. Audio is never saved. The conversation is saved on your computer, one file per session beside the workspace's tasks: what you said, what was said back, and what became of each request (handed to a task, not sent and why, or answered by voice), with anything shaped like a key removed. See [Data and storage](/docs/data-and-storage#what-leaves-your-computer) and the [privacy policy](/privacy).

## If something goes wrong

The voice bar says what happened in plain words, with one way to fix it: "Voice settings" for a missing or rejected key, "Open mic settings" for a blocked microphone, or "Try again" after a lost connection or a microphone that was unplugged. A lost connection is retried on its own first. If only speaking fails, voice mode keeps listening and the answers stay on screen.
