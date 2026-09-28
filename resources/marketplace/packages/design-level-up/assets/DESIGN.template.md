---
# DESIGN.md - the design system every agent reads before it designs.
# The front matter holds machine-readable tokens; the sections below explain intent.
# Shape follows the Google Labs DESIGN.md spec (alpha, github.com/google-labs-code/design.md);
# check the current schema there before linting with its CLI. Sections after
# "Do's and Don'ts" are extensions (motion, imagery, voice, provenance); tools that do not
# know them ignore them.
#
# Every value below is a worked example for a fictional roaster, "Ember Coffee Co.".
# Replace all of it. Keep the structure.
name: Ember Coffee Co.
colors:
  primary: "#B8471F"        # burnt orange; white text on it passes 4.5:1
  on-primary: "#FFFFFF"
  background: "#F7F3EC"
  surface: "#FFFFFF"
  text: "#1F1B16"
  muted: "#6B6259"          # secondary text; 5:1 on background
  border: "#E6DED2"
  accent-soft: "#F6E3D8"    # tinted fill behind badges and highlights
typography:
  display:
    fontFamily: "Fraunces"          # Google Fonts, SIL OFL
    fontSize: 56px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -0.02em
  heading:
    fontFamily: "Fraunces"
    fontSize: 28px
    fontWeight: 600
    lineHeight: 1.2
  body:
    fontFamily: "General Sans"      # Fontshare, ITF Free Font License (self-host ok, never redistribute)
    fontSize: 17px
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "General Sans"
    fontSize: 13px
    fontWeight: 500
    lineHeight: 1.3
    letterSpacing: 0.02em
rounded:
  sm: 6px
  md: 12px
  lg: 20px
  pill: 999px
spacing:
  base: 4px
  scale: [4, 8, 12, 16, 24, 32, 48, 64, 96]
components:
  button-primary:
    background: "{colors.primary}"
    text: "{colors.on-primary}"
    rounded: "{rounded.md}"
    padding: "12px 20px"
  card:
    background: "{colors.surface}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.lg}"
---

# Ember Coffee Co. design system

## Overview
Small-batch roaster selling subscriptions to people who care where beans come from.
Essence in three words: **warm, tactile, unhurried**. The site should feel like a paper
bag of beans on a wooden counter, not a SaaS dashboard.
Audience: 28-45, cooks at home, distrusts hype. Primary action: start a subscription.

## Colors
- `primary` is for the one action that matters on a screen. Never two primary buttons side by side.
- `muted` carries metadata and secondary text; defaults stay muted so changes stand out.
- `accent-soft` is the only tint. No gradients except the photo overlays described in Imagery.
- Dark mode: `background #16130F`, `surface #1F1B16`, `text #F3EDE4`, `muted #A89F94`,
  `primary #E07A4F` with `on-primary #16130F`.

## Typography
- Display and headings: Fraunces 600, tight tracking at large sizes only.
- Body: General Sans 400 at 17px; never below 13px anywhere.
- Scale (px): 13 / 15 / 17 / 21 / 28 / 40 / 56. Nothing off the scale.
- Load: Fraunces from Google Fonts; General Sans from `api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap`.

## Layout
- 4px base unit; spacing only from the scale in the front matter.
- Content width 1120px; text columns 64ch max.
- Mobile first; breakpoints 640 / 960 / 1280.
- One left edge per column. Align before you add a divider.

## Elevation & Depth
- Flat by default. One shadow, for things that float above the page (menus, sticky cart):
  `0 12px 32px rgb(31 27 22 / 0.12)`.
- Separation comes from spacing and the `border` color, not stacked shadows.

## Shapes
- `rounded.md` for controls, `rounded.lg` for cards and images, `pill` for tags.
- Photos get `rounded.lg`; illustrations and icons are never boxed.

## Components
- **Button**: primary (filled), secondary (1px border, text color), quiet (text only).
  States: hover darkens 6%, focus shows a 2px `primary` ring offset 2px, disabled at 40% opacity.
- **Card**: surface, border, `rounded.lg`, 24px padding; the image bleeds to the edges.
- **Nav**: logo left, 4 links max, one primary button right. Collapses to a sheet under 960px.
- **Form field**: 44px tall, label above, helper text in `muted`, error text paired with an icon.

## Do's and Don'ts
- Do use real photography of beans, hands and brew gear. Don't use stock "people laughing at laptops".
- Do write short, concrete copy (origin, roast date, tasting notes). Don't use "elevate", "unlock", "seamless".
- Do keep one icon set (Phosphor Regular, 1.5px stroke). Don't mix styles or use emoji as icons.
- Don't use purple, neon, or glassmorphism. Don't center everything.

## Motion
- Durations: 120ms (hover), 200ms (small moves), 400ms (section reveals). Easing `cubic-bezier(.2,.8,.2,1)`.
- Motion explains, it does not decorate: reveal on scroll once, never loop.
- Respect `prefers-reduced-motion`: fade only, no movement.

## Iconography & Imagery
- Icons: one pack in one style, SVG, `currentColor` so they follow the theme.
- Image generation prompt stem: "overhead natural-light photo, warm wood surface, kraft paper, shallow depth of field, muted film grain".
- Illustrations: none. Photography carries the brand.

## Voice & Copy
- Plainspoken, specific, a little dry. Short sentences. Numbers over adjectives ("roasted 3 days ago").
- Banned words live in `banned-words.txt` (one per line) so scripts/slop_check.py can enforce them.
- Patterns borrowed from the niche leaders: origin story in one line, roast date on every product, subscription flexibility stated up front.

## Provenance
- Type from Refero style "Editorial magazine" (display pairing); color and restraint from the brand's own packaging.
- References: links or screenshots in `references/` with one line on what to take from each.

## Tokens as CSS
```css
:root {
  --color-primary: #B8471F;  --color-on-primary: #FFFFFF;
  --color-bg: #F7F3EC;       --color-surface: #FFFFFF;
  --color-text: #1F1B16;     --color-muted: #6B6259;
  --color-border: #E6DED2;   --color-accent-soft: #F6E3D8;
  --font-display: "Fraunces", Georgia, serif;
  --font-body: "General Sans", system-ui, sans-serif;
  --text-sm: 13px; --text-base: 17px; --text-lg: 21px; --text-xl: 28px; --text-2xl: 40px; --text-3xl: 56px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-6: 24px; --space-8: 32px; --space-12: 48px; --space-16: 64px;
  --radius-sm: 6px; --radius-md: 12px; --radius-lg: 20px;
  --shadow-float: 0 12px 32px rgb(31 27 22 / 0.12);
  --motion-fast: 120ms; --motion-base: 200ms; --motion-slow: 400ms; --ease-out: cubic-bezier(.2, .8, .2, 1);
}
@media (prefers-color-scheme: dark) {
  :root {
    --color-bg: #16130F; --color-surface: #1F1B16; --color-text: #F3EDE4;
    --color-muted: #A89F94; --color-primary: #E07A4F; --color-on-primary: #16130F; --color-border: #2E2923;
  }
}
```
