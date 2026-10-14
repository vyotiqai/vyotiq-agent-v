# Voice view mockups

Three directions for the voice view (docs/voice-mode.md §25, §24.7), for a pick
before anything is ported.

```bash
pnpm redesign:voice-view
```

Then open http://localhost:5219. Pick a direction, a scene, an orb, a skin and a
theme in the bar. `?v=a|b|c|orb&scene=<id>&orb=<look>&skin=<skin>&theme=light|dark&size=1024|1280|1440&bare=1`
renders a single frame without the bar, for screenshots.

| Direction | Idea |
| --- | --- |
| A · Conversation | The conversation is the page. The orb docks in the bar under it, so nothing scrolls under the orb. A hand-off owns its task's live steps, which turn into its result in place |
| B · Orb | A large orb, with the one thing worth reading under it: your words, its words, the live steps or the result. The whole conversation opens beside it |
| C · Split | The conversation is under the orb on the left. The right column shows the task's every step, the question it's waiting on, and its full result |
| The orb | The orb alone, rendered live: one orb living through a conversation, and every state side by side |

The same fixes are in all three:

- The header names the task the session follows, instead of "OpenRouter · OpenRouter".
- Each speaker has one name: You, Agent V (the voice), and its Task (the work).
- A hand-off is one folded line ("Doing …"), not a "To the agent" paragraph.
- A turn split by a pause reads as one turn.
- The orb is a live WebGL sphere (`vv/LiveOrb.tsx`). Its colour flows inside, its edge ripples with the voice level, and its glow breathes. Each state has its own motion, with smooth changes between states. Colours are derived from the skin's tokens. It pauses offscreen, shows one still frame per state under reduced motion, and falls back to the SVG orb without WebGL.
- A conversation can no longer be clipped under the orb.

Scenes cover these states:

- Listening (empty)
- Hearing, with live words
- Thinking
- Working, with live steps
- Speaking
- Result
- Needs you, with an inline approval
- Error
- Muted
- A long conversation with two tasks

It uses the same stack as the other mockups:

- the real `--vy-*` tokens
- `lib/ui` and `lib/icons`
- `VOICE_STATE_LABEL`

It lives under `src/`, which keeps it out of the shipped app: electron-builder excludes `src/**`, and the folder is outside `tsconfig.web.json` and the renderer's Tailwind scan.

## Shipped

The voice view shipped with all three directions as a setting (Settings ›
Voice mode › Voice view › Layout, docs/voice-mode.md D-51), and every orb look
as another (› Orb). **App · Conversation / Orb / Split** in the bar render the
app's own view (`features/voice/view/layouts.tsx`) on these scenes, so what
shipped can be compared with the mockup it came from.

## Orb looks

The **Orb** menu swaps the orb in every direction and the gallery. They are
the app's orbs, imported from `src/renderer/src/features/voice/orb/`: the
nine from the design canvas "Agent V voice orbs"
(https://claude.ai/artifact/9pifSoPQY6EsZXeuCy4ZrN), Liquid (the first live
orb) and Simple (the drawn one). Edit them there; the mockup has no copy.
