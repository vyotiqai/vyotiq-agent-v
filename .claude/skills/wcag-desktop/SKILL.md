---
name: wcag-desktop
description: Apply WCAG 2.2 AA to VYOTIQ's renderer when designing, building or reviewing any UI surface - contrast, target size, focus, keyboard, hover content, dragging, status messages. Use it for any new pane, row, menu, dialog or control, for token or skin changes in styles.css, and for design reviews, even when the request only says "polish" or "restyle".
---

# WCAG 2.2 AA for VYOTIQ, distilled

Source: https://www.w3.org/TR/WCAG22/ (Recommendation, updated 2024-12-12; checked 2026-09-27).
Target-size detail: https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html

These rules sit under CLAUDE.md's UI rules. When a CLAUDE.md look and a number here
disagree, the number wins and the look adapts (the fix is usually in the neighbours).

## Numbers to hold

| Criterion | Requirement | Where VYOTIQ enforces it |
|---|---|---|
| 1.4.3 Contrast | Text 4.5:1; large text (24px, or 18.66px bold) 3:1 | `tests/shared/skinContrast.test.ts`, all 5 skins x light/dark |
| 1.4.11 Non-text contrast | Control edges, icons, focus rings 3:1 against what's next to them | `--vy-focus` and `--vy-accent` pinned at 3:1 on bg |
| 2.5.8 Target size | 24x24 CSS px, or a 24px circle on its center touches no other target | `IconButton size="xs"` hits at 24px via its `before:` plate |
| 1.4.12 Text spacing | Survives line-height 1.5, paragraph 2x, letter 0.12em, word 0.16em | No fixed-height text boxes that clip |
| 1.4.10 Reflow | Usable at 320 CSS px wide without 2-D scrolling | Panes collapse; check the narrowest pane width |
| 1.4.4 Resize text | 200% without loss | `data-font-scale` and Ctrl +/- must not clip |

## What each token is for (after the 2026-09-27 contrast pass)

- `text-fg`, `text-secondary`: any text.
- `text-muted`: passes 4.5:1 on every plane (bg, card, sunken, chrome, surface, surface-2).
- `text-tertiary`: passes 4.5:1 on `bg` only, and 3:1 on every other plane. Use it for
  metadata that repeats or can be inferred (hashes, counts, timestamps, section labels). For a
  sentence the user must read to act (for example "The run waits for your answer" on a
  selected row), use `text-muted`.
- `text-success/warning/danger/accent`: pass on every plane and on their own `-soft` tint.
- Disabled text is exempt (1.4.3), but it still needs a non-colour cue (`vy-disabled-state`).

## Target size (2.5.8)

- Standalone targets are 24px or larger: `IconButton sm` and up, `Button xs` and up.
- `IconButton xs` draws 20px but hits 24px. Keep neighbours `gap-1` or wider; at `gap-0.5`
  the hit areas overlap and the one later in the DOM steals the click.
- A button under 24px sitting inside or against a larger clickable row fails, because its
  circle crosses the row. The 24px hit area is what makes row hover actions pass.
- Put destructive and cancel next to each other only at `gap-1` or more (the navigator's
  inline Delete? confirm is the pattern).

## Focus and keyboard (2.1.1, 2.1.2, 2.4.3, 2.4.7, 2.4.11)

- The global `:focus-visible` outline (styles.css) covers raw buttons; primitives add
  `focus-visible:vy-focus-ring`. Never `outline-none` without a replacement.
- Menus using active-descendant show the active row with `MENU_ROW_ACTIVE`; that fill is the
  focus indicator, so it must stay distinct from hover.
- A sticky header or the 36px title bar must never fully cover a focused element (2.4.11):
  scrolling containers need `scroll-padding-top` when something sticks over them.
- Dialogs trap focus (`lib/a11y/Dialog.tsx`) but Escape always leaves (2.1.2).

## Hover and focus content (1.4.13)

Tooltips and hover cards must be: dismissible with Escape without moving the pointer,
hoverable (the pointer can move onto them), and persistent until the trigger goes away. Use
`lib/ui/Tooltip`; don't build a second one.

`lib/ui/Tooltip` meets all three (fixed 2026-09-27): Escape dismisses it; a 120ms grace
and a wrapper whose padding is the 6px gap let the pointer cross onto the tip; and presses on
the tip stop natively, so selecting its text never clicks the row behind the trigger. Only one
tip is open at a time.

## Dragging (2.5.7)

Every drag needs a single-pointer alternative, meaning a click, not just keys. Keyboard
support (2.1.1) is required too, but it doesn't satisfy 2.5.7 on its own. Reorderable lists
need a menu action (Move up/down).

`PanelResizeHandle` takes Arrow, Shift+Arrow, Home and End, and a double-click snaps the
pane back to `defaultValue` (added 2026-09-27). Pass `defaultValue` to every new handle.

## Colour and state (1.4.1, 4.1.2, 4.1.3)

- Meaning is never carried by hue alone: diff rows pair tint with a `+`/`-` gutter sign;
  status pairs colour with `StatusGlyph` or a word.
- Every icon-only control has `aria-label` (IconButton requires `label`).
- Toggles set `aria-pressed`; disclosures set `aria-expanded`.
- Run progress, "Copied", and errors that appear without focus use `role="status"` or
  `aria-live` (4.1.3).

## Review checklist

- [ ] Contrast: `node node_modules/vitest/vitest.mjs run tests/shared/skinContrast.test.ts`
      passes; for a new token pairing, add it to that test.
- [ ] Informative text on hover/selected fills uses `text-muted` or stronger, not `text-tertiary`.
- [ ] Every target is at least 24px, or `IconButton xs` with neighbours `gap-1` or wider.
- [ ] Tab reaches every control in visual order; a focus ring is visible on each.
- [ ] Escape closes every popover, tooltip and dialog; nothing traps focus.
- [ ] Drags have a click alternative as well as keys (`PanelResizeHandle` needs `defaultValue`).
- [ ] Status appears as a glyph or word, not only as a colour.
- [ ] Checked in light and dark, at the narrowest pane width, and at `data-font-scale="large"`.
