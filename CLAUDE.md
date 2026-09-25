# CLAUDE.md

## UI design rules

These are **UI** rules — how a surface looks and reads. They do not settle **UX**
questions (what the flow is, what information lives where, whether a screen
should exist). If a change needs that kind of decision, say so and ask; don't
resolve it by restyling.

### Where the system lives

| What | Where |
| --- | --- |
| Tokens, `@theme` mapping, `@utility` helpers | `src/renderer/src/styles.css` |
| Shared primitives (Button, IconButton, Badge, Tabs, Segmented, StatusGlyph, Keys, ProgressBar/Ring, Menu, Tooltip, FormRow…) | `src/renderer/src/lib/ui/` |
| Icon allowlist | `src/renderer/src/lib/icons/index.tsx` |
| Feature surfaces | `src/renderer/src/features/` |

Tailwind v4, CSS-first — there is no `tailwind.config.*`. Semantic `--vy-*` tokens
are mapped to Tailwind names in the `@theme` block, so `bg-surface`, `text-muted`,
`border-border-strong` and `rounded-lg` all resolve through the token layer.

### Four constraints that break things silently

1. **One weight per role — never invent a new opacity.** Hover fills and
   borders each collapsed from eight ad-hoc opacities to a named set in
   `lib/utils/layout.ts`; reaching for a ninth is how they got that way.
   Hover: `CONTROL_HOVER` (`hover:bg-surface`) for a button, nav item, tab or
   icon target; `HOVER_ON_SURFACE` (`hover:bg-surface-2`) for the same thing
   where the base is already `bg-surface`; `ROW_HOVER` (`hover:bg-surface`)
   for a row in a scrollable list. `SELECTED` (`bg-surface-2 text-fg-strong`)
   is the one fill for "the one you're on". Borders: full `border-border`
   **outlines a thing**, `BORDER_DIVIDER` (`border-border/60`) **separates two
   things inside it**, and `DIVIDER_FILL` (`bg-border`) is that same grey drawn
   as a background — a 1px rule, a progress track, a zero-value bar. Tints are
   the named `-soft` tokens (`bg-accent-soft`, `bg-danger-soft`…), never
   `bg-accent/15`. If a surface seems to need an in-between weight, the
   problem is its neighbours.

2. **Never hardcode a color.** Every surface renders under five skins
   (`default`, `proof`, `bench`, `native`, `gild`) × light/dark. A literal hex
   is wrong in at least nine of those ten combinations. Use the semantic token,
   not a `--vy-gray-*` ramp — those are legacy. Two real exceptions exist and
   are the only shapes that justify a literal: a fallback when reading a CSS var
   into a JS theme object that can't take `var()`
   (`features/chat/components/TerminalPanel.tsx`), and a third-party brand color
   (`features/chat/toolUi/siteBrands.tsx`).

3. **`cn()` is `filter(Boolean).join(' ')` — there is no tailwind-merge.**
   Appending a utility does *not* override an earlier one, and two different
   things decide the winner — neither of them your argument order. Between two
   base utilities it is emission order in the generated sheet, which is why
   appending `pointer-events-auto` after `pointer-events-none` leaves an element
   visible but dead. Against a variant you simply lose: Tailwind emits
   `group-hover:x` as `.group-hover\:x:is(:where(.group):hover *)`, specificity
   (0,2,0), so a bare `.x` at (0,1,0) can never win no matter where it sits.
   Write the two states as a ternary so only one class is ever present.
   A jsdom `classList.contains(...)` assertion is enough to guard it — see
   `tests/renderer/ui/panelResizeHandle.test.tsx`.

4. **Import icons from `lib/icons`, not `@phosphor-icons/react`.** The allowlist
   is what keeps the icon set coherent and the bundle bounded. Add the export
   there first.

### The principles

**Anchor to edges.** Elements line up on hard vertical and horizontal edges —
one left edge per column, one right edge for trailing content. Structural
alignment is what holds a dense layout together, so reach for it before adding a
divider, a border, or more padding. If a row needs a rule to look organized, the
alignment is usually the thing that's wrong.

**Differentiate, don't dilute.** Density is an asset when the eye can parse it.
The fix for a wall of text is grouping (by date, by status, by owner) and a
visual anchor per group — not more white space. Whitespace alone just makes the
same undifferentiated block taller.

**Show, don't tell.** When a surface is confusing, the reflex is to add a label,
a tooltip, or a sentence of helper text — and the screen gets harder to read.
Prefer a recognizable icon or a small diagram that registers at a glance. A
tooltip is for a detail the icon can't carry, never a substitute for a clear one.

**Design for scannability.** Nobody reads a screen top to bottom. They arrive
with a question and hunt for its answer. Every rule above exists to make that
hunt faster; when two layouts are otherwise equal, ship the one that answers the
likely question sooner.

**Emphasis comes from the neighbours.** Emphasis is contrast with what's
adjacent, not a property you add to an element. Don't bold or brighten the thing
you want noticed — mute everything around it. Default and unchanged values go in
`text-muted` or `text-tertiary` so anything set away from its default draws the
eye on its own.

**Dissolve cards into the layout.** Prefer structural rows and columns over
stacked cards in containers; borders on borders read as clutter. Panes are flush
in every skin: `vy-panel` is the pane background plus one hairline on its left,
with no gap, radius or shadow. Menus and popovers use `vy-menu`
(`MENU_SURFACE`); rows inside them use `MENU_ROW` and its one-of text and fill
classes. Every pane starts with a 40px row (`h-10 border-b`): text-first rows pad
`pl-4 pr-2`, control-first rows `px-2`, and buttons in it are `size="xs"`.

### Never

- Carry meaning in hue alone. Diff rows pair tint with a `+`/`−` gutter sign;
  status pairs color with an icon or a word. Keep that pattern.
- Drop the focus ring. Interactive elements use `focus-visible:vy-focus-ring`.
- Re-open the transcript redesign. Borderless rows, a glyph column, and tighter
  gaps were tried and reverted — they made the timeline harder to read, not
  easier. The Work record (2026-09-23, shipped as 1.0.0) replaces the chat
  transcript with a record of steps, but keeps terminal and
  diff output in bordered cards for the same reason. "Dissolve cards into the
  layout" does not apply to those.
- Use a type size off the scale: `2xs` 10 (keycaps only), `caption` 11, `xs`
  12, `sm` 13 (body), `md` 14, `heading` 15, `title` 18, `display` 24.
  `3xs` and `lg` are legacy aliases until their last caller is ported.
- Style the top 36px band casually. Title-bar z-order, the drag region, and the
  caption strip have collided three times; verify changes there with the
  Electron e2e, not by reading classes.

### Reviewing a UI change

Check, in this order: token usage (no literals), `cn()` overrides (none),
alignment (edges, not dividers), emphasis (muted defaults), icon source
(`lib/icons`), focus ring, and both themes. `eslint .` is the formatting gate —
do not run `prettier --write`, it churns untouched lines against house style.
