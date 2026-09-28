---
name: BRAND-design
description: Apply the BRAND design system to anything visual - landing pages, app screens, slides, one-pagers, social posts, emails, motion graphics. Use whenever the user asks for BRAND material, mentions BRAND styling, or invokes BRAND-design, even for a quick mockup.
---

<!--
  TEMPLATE (design-level-up, Easy trick 4). To use it:
  1. Copy this file to <skills folder>/BRAND-design/SKILL.md and replace every BRAND.
     The folder name and the `name:` field must match (lowercase, digits, hyphens).
     Keep "claude" and "anthropic" out of the name if it will ever be uploaded to claude.ai.
  2. Put the brand's DESIGN.md (assets/DESIGN.template.md shows the shape) next to it,
     plus an assets/ folder: logo.svg, fonts/ (only if the licence allows copying them),
     icons/ (one pack, one style), images/ (approved photography), references/.
  3. Delete this comment.
  Skills folders: Claude Code .claude/skills or ~/.claude/skills; Codex, Cursor, Gemini CLI
  and Copilot also read .agents/skills; Vyotiq reads .vyotiq/skills or ~/.vyotiq/skills;
  claude.ai and Cowork take the folder as a ZIP upload.
-->

# BRAND design system

Everything visual for BRAND starts from `DESIGN.md` in this folder. Read it before you
draw anything: it holds the tokens (color, type, spacing, radius, motion), the components,
the voice, and the do/don't list. Brand assets are in `assets/`.

## Non-negotiables
- Use only the tokens in DESIGN.md. If something seems to need a new color or size, the
  layout around it is usually the problem; ask before adding a token.
- Fonts, icons and imagery come from `assets/` or the sources named in DESIGN.md.
- Copy follows the Voice section; words from `banned-words.txt` never ship.
- Every screen works at phone width, in light and dark, with a visible focus ring.

## How to work
1. Restate the brief in one line: audience, the one action, the format and size.
2. Pick the components you need from DESIGN.md before writing markup.
3. Build with the tokens exposed as CSS custom properties (see "Tokens as CSS"), so the
   result can be tuned later with a tweak panel.
4. Look at it rendered (screenshot or browser) at 390px and 1440px wide, both themes.
5. Check it against the list below, fix, and only then hand it over.

## Before you hand over
- [ ] Only DESIGN.md tokens; no stray hex values or off-scale sizes
- [ ] Display and body fonts are the brand's, loaded correctly
- [ ] One icon set, SVG, following `currentColor`
- [ ] Copy is specific and in the brand voice; nothing from `banned-words.txt`
- [ ] Contrast 4.5:1 for body text; tap targets at least 44px
- [ ] Motion respects `prefers-reduced-motion`
- [ ] Optional: `python <design-level-up>/scripts/slop_check.py <files> --banned-words banned-words.txt`
