# Glass composer mockups

The composer and every popover that opens from it, rebuilt in the dark glass of
the reference prompt bar (the "Ask AI" pill with the × beside it).

    pnpm redesign:glass   → http://localhost:5215

`?v=a|b|both&scene=<id>&bare=1` picks the variant and the state; `bare=1`
drops the viewer chrome for screenshots.

## What is real, and what is replicated

The composer's components are hand-built replicas of the source, not imports.
Their markup and classes are copied line for line from these files:
`Composer.tsx`, `ModePicker.tsx`, `ModelPicker.tsx`, `ContextMeter.tsx`,
`AttachMenu.tsx`, `take/MicControl.tsx`, `take/TakeStrip.tsx`, `MentionMenu.tsx`,
`SlashCommandMenu.tsx`, `StructureStrip.tsx`, `ComposerAttachments.tsx`,
`ModelReadinessBanner.tsx`, `ComposerMentionInput.tsx` and `NewTaskBrief.tsx`.

The words and orders are not retyped. They come from the app's own pure
helpers, imported:

| What | From |
| --- | --- |
| Placeholders | `resolveLinePlaceholder` |
| Agent / Ask and their titles | `MODES`, `shortcutLabel` |
| Effort ladder, its notes, the foot note | `buildModes`, `effortNotes`, `effortFootNote` |
| "N steps at High — Medium spends…" | `shouldSuggestLowerThinkingEffort`, `nextLowerThinkingEffort` |
| Speed labels | `SERVICE_TIER_LABELS` / `_DESCRIPTIONS` |
| Prices and context sizes | `resolveModelPrice`, `formatTokens` |
| The @ menu's rows, groups and lists | `buildRootMentionItems`, `buildMentionRootSections`, `buildFileMentionItems`, `buildDocsMentionItems`, `buildRuleMentionItems`, `buildCommitMentionItems`, `buildChatMentionItems` |
| The / menu's rows, groups and footer | `BUILTIN_COMMANDS`, `buildSlashDisplayList`, `slashRow*`, `slashAcceptHint`, `slashFooterText` |
| Chip glyphs, file icons | `slashKindIcon`, `fileIconUrl`, `FileTypeIcon` |
| The image preview | `ImageLightbox` |
| Dictation choices | `DICTATION_LOCAL_CATALOG` |

The `lib/ui` primitives are the real ones: Button, IconButton, Segmented,
Keys, Pie, Alert, Badge, FileChip, ImageChip, MenuItemBody and the `MENU_*`
classes. So are the provider logos. Only the data is sample data: one task on
Claude Opus 5 at High, 42 steps in, 12% of its context used.

## Everything in the composer works

A scene is where the composer starts, not a picture of it. Every control
does what the app's does, against the mockup's own state (`glass/actions.tsx`
over `glass/store.tsx`). Pick a scene again to start it over.

- **The field** is a real contentEditable. Paste is plain text. Typing `@`
  (after a space or at the start) or `/` (as the whole line) opens its menu,
  filtered by what follows. The arrows move the highlight, and Enter, Tab or
  a click takes the row as a chip, with the caret after it. Esc closes the
  menu, and it stays closed until a new `@` or `/`. In the @ menu a Browse
  row opens its list (Files and folders with "Show N more", Docs, Rules,
  Commits, Past tasks); the chevron or Esc goes back.
- **Send** starts a run and empties the field. A live run stays live until
  **Stop** (or Esc). While it is live, Enter **queues** (the row above the
  box has Edit, Send now and Remove) and Shift+Enter is **Send now**. Send,
  Start task and Rerun are off until there is something to send: words, a
  chip or an attachment.
- **Attach**: Files… and Image… / Screenshot add the sample chips (the image
  opens in the app's lightbox; × removes either). Mention a file types the
  `@`.
- **Dictation**: the mic (or Ctrl+M) opens a take. Insert (Enter, Ctrl+M or the
  live mic), Discard (Esc) and Send (Ctrl+Enter) work. An inserted take shows
  Undo (Ctrl+Z), which takes back only its words. Without dictation set up,
  the mic opens Dictate with, and Install or Use starts the take.
- **Structure** (its button or Ctrl+Shift+Enter) locks the field and writes a
  sample brief after 1.8s. Cancel (Esc) leaves your words. Once done, Undo
  (Ctrl+Z) restores them, Try again rewrites, and × hides the row and keeps
  the brief.
- **Mode**: the switch, Ctrl+. and ⇧Tab in an empty box.
- **Model and effort**: the search filters, the arrows and Enter (or a click)
  pick a model, which the trigger then names. Effort, Speed and the stars
  work, and so does "Use Med".
- **The brief**: Enter is a new line and Ctrl+Enter starts the task, which
  turns the brief into the line with the run live. Done when's input adds a
  check on Enter, and × removes one.
- **Edit and rerun**: Rerun (Enter) starts the run on the line. Cancel (Esc)
  goes back to the line.
- **The error** has Retry and Dismiss. The missing-key banner's Add API key
  clears it.
- **Popovers** follow their trigger as the composer moves (B's rail
  unfolding, the field growing). Focus follows the app: the model picker,
  Dictate with and the attach menu take focus as they open, the arrows walk
  the attach menu, and Esc or a pick hands focus back.

What does nothing, on purpose: controls that open another part of the app
(Add folder…, Save as draft, Schedule…, the approval note's Change, Add a
provider…, Refresh the catalog, Compact history, Dictate with's Add key,
which closes the panel), and the other providers' tabs. The sample has
models for Anthropic only.

## The glass layer (`src/styles.css`)

This is a skin over native-dark, not new components. It sits on the same
element as `data-skin`/`data-theme`, so the app's named tints re-derive from
it. Every literal is in that one block, and every value in it was measured
from the reference (pixel samples, luminance 0–255), not eyeballed.

- **No hue.** The reference has none, so emphasis is luminance: text in four
  greys and a light accent. Status colours keep their hue, because meaning
  needs it. The greys sit higher than native-dark's because the fill is
  near-black. The quietest one still clears 5.4:1 on the brightest backdrop
  behind the rail.
- **Capsules.** The radius follows the control's height: `md` is 14px (half
  of 28) and `sm` is 10px (half of 20). Every button, segment, menu row and
  keycap becomes a capsule without a single class changing.
- **Material.** Near-black and nearly opaque (the reference's pill reads
  5–24). The ends are a little clearer, so the bright backdrop shows through
  the left cap the way it does in the reference. One soft glow sits under the
  middle. The 1px rim is lit from above (~45% white on top, ~20% along the
  bottom), as both the reference's pill and its circle are. A deep, soft drop
  shadow lifts it off the backdrop.
- **The backdrop** is the reference's soft-focus fluted glass: hard light
  (a bright left band, a bright top-right corner) drawn once as a haze and
  once through two lens grids a pixel apart, whose beat is the moiré.
- **Popovers** are the same material, denser, and portal outside the box. A
  backdrop-filter nested in another one only sees its parent, so a popover
  inside the box would blur nothing.
- **Fallbacks.** Without `backdrop-filter`, or under
  `prefers-reduced-transparency`, the glass turns solid. Under
  `prefers-contrast: more` the rim firms up and the quiet greys lift.

## Two materials: Frosted and Liquid

The toolbar switches between them (`?m=frosted|liquid`). Both use the same
shapes, tokens and backdrop.

**Frosted** is the reference's own material: a near-opaque, blurred dark
glass with a lit rim. It is glassmorphism, not Apple's Liquid Glass. The
reference is the same: measured, its dot pattern does not bend anywhere
under the pill.

**Liquid** is the real thing, as far as the web allows (`glass/liquid.ts`):

- **Refraction.** Every glass surface gets its own SVG filter as its
  `backdrop-filter`. It displaces the backdrop by a map drawn from the
  element's real shape: flat in the middle, and over a ~16px bezel a convex
  squircle rim refracting through glass of index 1.5. The map is redrawn
  when the size changes (the pill growing as words wrap, a popover opening).
  This works only in Chromium. That is fine for Agent V, which is Electron.
- **Clear, with a calm middle.** The tint is laid once across and once down,
  each clear over the bezel. The rim shows the bent backdrop, while the
  middle, where the words are, is darker. This is how readability is kept;
  measured, every grey still clears 4.5:1 there.
- **Light that moves.** The rim's specular highlight follows the pointer.
- **Motion.** Popovers arrive on a spring, Stop/Cancel emerges from the pill's
  end as if it split off, and glass controls give under a press. All of it
  is off under `prefers-reduced-motion`.

**Reduced transparency.** Under `prefers-reduced-transparency` (Windows:
Settings → Personalization → Colors → Transparency effects off) both
materials draw solid, as the app should. That setting is off on the machine
this was built on, so the viewer shows **Preview glass** to see the material
anyway; `rt=1` shows what those readers get.

## A · Your anatomy

Nothing is moved. This is the 2026-09-28 anatomy as it ships: the field, the
attachments, then one control row (mode, model · effort, context, Structure,
attach, mic, Stop while live, the one action). The three surfaces keep their
own shapes: the line, Edit and rerun, and the New task brief with its Done
when list and the quiet row under it. Only the material changes. The box's
22px radius runs parallel to the 28px capsules about 9px inside its corner.

## B · The reference's shape

Every size comes from the pill's height, H = 56px, and the reference's own
proportions:

- The radius is H/2 = 28px.
- Every control in the pill is 28px and inset 14px. Each one is centred on a
  cap's centre, and the capsules run parallel to the pill's ends.
- Controls are 8px apart, so neighbouring glyphs are 36px (0.64 H) apart,
  as the reference's mic and waveform are.
- The text edge is 50px in. The rail below starts on it, and its right end
  stops on the action's edge.
- The one thing outside the pill is a 36px circle (the reference's is 0.65 H),
  8px off, on the pill's centre line. It is the way out of what the pill is
  doing: **Stop** while a run is live, **Cancel** while editing. Otherwise
  nothing sits there.
- The pill's tools (attach, Structure, the mic) take the `default` tone. They
  are all the pill holds, so they are its focal points, as the reference's
  white glyphs are. In A they stay `muted`, as in the app. The ↑ is the one
  filled thing: emphasis by contrast with its quiet neighbours.
- The rail's popovers (model, context) open above the pill, never over it.
  In the app their trigger is inside the box, so covering the field is fine
  there. In B the same rule would bury the pill.
- When the words wrap, the pill grows into a rounded rectangle and the caps
  keep the bottom line.

What shows, and when. These are the user's picks of 2026-10-09, made to
get "as clean and minimal as the image". Each reverses part of the
2026-09-28 anatomy, which A keeps.

- **Empty, the pill is the reference:** `+`, the placeholder, the mic. Nothing
  else, in or under it.
- **Send swaps in.** Once there is something to send, the right cap's mic
  gives way to a round ↑: Send, Queue while a run is live, Rerun while
  editing. Its words are in its name and tooltip; Shift+Enter is Send now.
  The mic comes back when the field empties, and dictation keeps its
  shortcut meanwhile. *Reverses the visible "Send ↵" word button.*
- **Structure shows only with something to structure**, beside the ↑.
  Its glyph is a list with checks (`listTodo`), in A too, not the app's
  sparkle. Sparkle already means skills, tips and What's new, and it sat
  beside a skill chip in the same field. Porting this changes
  `Composer.tsx` and `StructureStrip.tsx`.
- **Attach is a `+`**, as in the reference. Open question: the app already
  uses `+` for **New task** (five places, and `/clear`, "Start a new task"). In
  the pill it reads as attach by its place and tooltip, but it is one glyph
  with two meanings until one of them changes. Giving `/clear` alone another
  glyph was tried and dropped: it broke the match with New task, and the
  refresh glyph read like `/loop`'s repeat.
- **Mode, model · effort and context sit on a rail under the pill that shows
  only while you are working**: the composer has focus, holds something to
  send, a run is live, or any popover is open. Hidden, it
  folds away (`grid-rows` 0fr ↔ 1fr, 200ms, none under reduced motion) and
  the pill settles to the bottom; it rises 36px when the rail returns.
  Folded, the rail is `inert`, so its controls leave the tab order. *Reverses
  an always-visible row.*
- **Every row above or under the pill sits on the pill's edges.** Its glyph
  is on the `+`'s centre line, its words on the text edge, and its last
  control on the action's edge. That covers the queue, Structure's row,
  dictation, the error and the missing key. The error and the missing key are
  rows, not boxes, so there is no box-in-a-pill or card with its own radius.
- **Every popover clears the pill**, opening past its top (or its bottom, for
  the brief), never over it. A menu from a button in the pill (attach, the
  mic) lines up with the pill's outer edge. The @ and / menus anchor to the
  words, so they keep the text edge.
- **Stop and Cancel are the round control outside the pill**, named by their
  tooltips.
- **The brief keeps its words**: Start task stays a labelled button and the
  mic stays beside it. Only Structure waits for text.
- **The waveform still has no counterpart.** The app has no voice-conversation
  mode, so nothing was invented for it.
- **A dictation take's strip stands in for the rail**, and the pill keeps
  only the live mic, as the app's row does.

## Decisions this does not make

- A or B. B is a structural change to the composer (a UX decision), not a
  restyle.
- Whether glass becomes a sixth skin. If it does, it needs a light theme,
  and its backdrop has to come from somewhere real: a wallpaper, or the
  record behind the composer.
- Slash chips lose their accent hue under a light accent. They keep their
  glyph, which is enough under "never hue alone", but they read closer to
  plain text than they do in the app.
