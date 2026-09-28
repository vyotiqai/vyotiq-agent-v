# Intermediate - assets and polish (techniques 8-19)

These assume the Easy foundation exists (at least a DESIGN.md with tokens). They swap the
placeholder parts of a design - stock images, hand-rolled sections, emoji icons, generic
copy - for real assets, proven components and an audit pass.

Contents: 8 Image/video generator - 9 Reuse a finished project - 10 Reference library -
11 De-slop audit - 12 Tone-of-voice skill - 13 21st.dev - 14 React Bits - 15 Canvas UI -
16 One icon pack - 17 Ask for SVG - 18 Animated icons - 19 Creators Toolbox - Level checklist

Facts about third-party tools were checked in September 2026. Prices, free tiers and
model line-ups change; confirm on the site before relying on them.

---

## 8. Connect an image and video generator

**Use when:** the design needs photography, illustration, product shots or video.

**Why:** Claude Design and most coding agents do not generate raster images or video.
Grey placeholders and stock photos are what make a good layout feel unfinished.

**How**
- Pick a provider. Kie.ai (https://kie.ai, docs at https://docs.kie.ai) puts many image,
  video and audio models behind one API and one pay-as-you-go credit balance; models come
  and go as vendors change terms. It has no official MCP server (community ones exist).
  Any provider the user already pays for works the same way.
- *File-system agents:* store the key in `.env` or the agent's secret store, let the agent
  read the provider's API docs, write a small script that takes a prompt, size and output
  path, generate one test image, then save the procedure as a skill (e.g. `generate-image`)
  that pulls the style stem from DESIGN.md's Imagery section and saves into `assets/generated/`.
- *Claude Design:* generate elsewhere and upload the files, or hand the project off to
  Claude Code and generate there.

**Prompt**
```
Set up image generation with [provider]. The API key is in .env as [VAR_NAME]; never print
or log it. Read the provider's API docs, write a small script that takes a prompt, size and
output path, and test it with one image in our Imagery style from DESIGN.md. Then save the
steps as a skill called generate-image so any design can call it. Log model and cost per image.
```

**Done when:** one on-brand test image exists, the skill works, and cost per image is known.

**Watch out:** a community MCP server is someone else's code running with your key; read it
before installing. Check usage rights for commercial work, and never generate real people's
likenesses without consent.

---

## 9. Reuse a finished project as the starting point

**Use when:** starting something new for a brand you have already designed for.

**Why:** the fastest route to consistency is to start where the last project ended, with
its system, components and assets, instead of re-describing the brand.

**How**
- *Claude Design:* the official route is a published design system (the org default) or
  Remix. Pasting the URL of a finished project into a new one and asking to reuse its system
  and assets is reported to work (you need view access), but it is not in the official docs.
- *Claude Code:* name the earlier session or ask the agent to find it, or better, point it at
  the folder or repo where the earlier design lives. Claude Code cannot open
  `claude.ai/design` project links; export a handoff bundle from Claude Design instead.
- *Any agent:* point at the earlier project's DESIGN.md and `assets/`, or use the brand
  skill from technique 4.

**Prompt**
```
Find the project where we built [X] ([path, repo, or session name]). Reuse its DESIGN.md,
components and assets as the base for [new thing]. List anything you had to change or add,
and add new tokens to DESIGN.md instead of hard-coding them.
```

**Done when:** the new work uses the earlier tokens and components, and changes are listed.

---

## 10. Curate a reference library

**Use when:** you want better taste in the output, or you keep describing a look in adjectives.

**Why:** taste grows with exposure, and agents follow concrete references far better than
"make it modern and clean". A library turns "I saw a nice site once" into material the agent can use.

**How:** save designs you like from Dribbble (https://dribbble.com), Awwwards
(https://www.awwwards.com), Refero, X or anywhere else into a `references/` folder: a
screenshot, the URL, the date, tags, and one line on what to borrow. Keep an index file
(`references/index.json`) so an agent can search it. Any capture tool works; an agent with a
browser or Playwright can take the screenshots itself. (The video's author uses a personal
one-click capture extension; it isn't publicly listed, so don't depend on it.)

**Prompt**
```
Capture full-page screenshots of these URLs at 1440px wide into references/: [urls].
For each, add an entry to references/index.json with url, date, tags, and one line on what
we should borrow (layout, type, motion or color). We borrow ideas, never copy text or assets.
```

**Done when:** screenshots plus index exist, and DESIGN.md's Provenance links the ones that shaped the system.

---

## 11. Run a de-slop audit

**Use when:** before any handover, and first when polishing an existing site.

**Why:** a draft becomes professional in the details: hierarchy, spacing rhythm, type,
contrast, empty and error states, copy. An audit finds them systematically instead of by eye.

**How**
- **Impeccable** (https://impeccable.style, repo github.com/pbakaus/impeccable, Apache-2.0,
  by Paul Bakaus): one skill with 24 commands and 61 deterministic detector rules, for
  Claude Code, Cursor, Codex, Gemini CLI, Copilot and more. Install with
  `npx impeccable install` (choose providers and project or global scope) or, in Claude Code,
  `/plugin marketplace add pbakaus/impeccable`. Useful order:
  `npx impeccable detect <path>` (no LLM; exit code 2 when it finds issues), then
  `/impeccable critique` (hierarchy, clarity), `layout` and `typeset`, `audit`
  (accessibility, performance, responsive), `onboard` (first-run and empty states),
  `clarify` (copy), `polish`.
- **No install:** `python scripts/slop_check.py <path> --banned-words banned-words.txt`
  flags default fonts, color and type-size sprawl, the stock purple gradient, AI-sounding
  copy, placeholder text, emoji icons, missing alt text, removed focus rings and motion
  without a reduced-motion fallback. It is a quick pre-flight, not a full critique.

**Prompt**
```
Audit [page or folder] for hierarchy, spacing rhythm, type, color, contrast, empty and error
states, and copy. Run [npx impeccable detect / scripts/slop_check.py] first. List issues by
severity with the fix for each, apply the fixes that don't change the brand, and show me
before and after screenshots.
```

**Done when:** errors are fixed, each warning is fixed or consciously accepted, and the
before/after has been looked at.

---

## 12. Build a tone-of-voice skill

**Use when:** anything with words ships under a brand or a person's name.

**Why:** unedited AI writing is easy to spot. A voice skill makes every agent write like
you, and it keeps improving because corrections are written back into it.

**How:** start from `assets/tone-skill.template.md` and keep `banned-words.txt` beside it
(one entry per line, so `slop_check.py --banned-words` can enforce it). Feed it 5-10 real
samples, how you open, how long your sentences run, words you use and words you never use.
Add established rule sets as short summaries with links, not copies:
ASD-STE100 Simplified Technical English (free from ASD after a short form; don't
redistribute the PDF), Google's developer documentation style guide
(https://developers.google.com/style) and the Apple Style Guide
(https://support.apple.com/guide/applestyleguide/welcome/web).

**Prompt**
```
Draft a tone-of-voice skill from [path to tone-skill.template.md] using these samples of my
writing: [paste 5-10]. Capture how I open, my sentence rhythm, the words I use, and this
banned list: [list] (also save it as banned-words.txt). Add short summaries of ASD-STE100,
Google's developer documentation style guide and the Apple Style Guide as rule sets, with
links. From now on, when I correct your wording, add the correction to the log in the skill.
```

**Done when:** the skill exists, new copy passes `slop_check.py` with the banned list, and
corrections are being logged.

---

## 13. Drop in proven components from 21st.dev

**Use when:** building standard sections (hero, pricing, testimonials, navbars) in React + Tailwind.

**Why:** a community-tested component is better than one generated from scratch, and
pasting it costs fewer tokens than describing it.

**How:** 21st.dev (https://21st.dev) catalogs 12,000+ React/Tailwind (shadcn/ui-style)
components. Its "Copy prompt" button gives an agent-ready prompt with context; you can also
install with `npx shadcn@latest add "https://21st.dev/r/<author>/<component>"` or use the
21st MCP server. Since June 2026 the free tier allows two copies a day (paid plans for more).

**Prompt**
```
Use this component for our [section]: [pasted prompt or code]. Keep its structure and
accessibility, restyle it only through our DESIGN.md tokens (no new colors or sizes), and
remove anything we don't need. Show it at 390px and 1440px.
```

**Done when:** the section matches the system, not the component's demo styling.

**Watch out:** check each component's author and licence; unstyled drop-ins make pages look
like the demo site.

---

## 14. React Bits for one signature effect

**Use when:** a page needs a moment of delight: animated headline text, a background, a
cursor effect, a glass card.

**Why:** a single well-made animated component signals craft; ten of them signal a template.

**How:** React Bits (https://reactbits.dev) has 200+ animated React components, free under
MIT plus Commons Clause (use them, don't resell them). Install with the shadcn CLI, picking
the language and styling variant, e.g. `npx shadcn@latest add @react-bits/BlurText-TS-TW`
(variants: JS-CSS, JS-TW, TS-CSS, TS-TW), or with jsrepo, or copy the code. Save chosen
components into the project and list them in DESIGN.md so they become part of the system.

**Prompt**
```
Add React Bits' [component] ([variant]) to [one place] only. Drive its colors and timing
from our tokens, respect prefers-reduced-motion, and add it to DESIGN.md under Components.
```

---

## 15. Canvas UI effects

**Use when:** one hero moment should feel special: liquid, glass, shatter, particle reveal.

**Why:** it is the kind of effect people associate with high-end sites, free and ready made.

**How:** Canvas UI (https://canvasui.dev), from the React Bits author, has 35 WebGL/WebGPU
effects that draw over live HTML, free under MIT plus Commons Clause. Install per framework,
e.g. `npx shadcn@latest add @canvas-ui/liquid-react` (React, Vue, Svelte, vanilla and more).

**Watch out:** effects that paint live HTML into a canvas currently need a Chrome flag or an
origin-trial token; other browsers get a reduced fallback. Test in the browsers your audience
uses, keep text readable without the effect, and use it once per page.

---

## 16. One icon pack, one style

**Use when:** any interface with icons. Replace every emoji icon.

**Why:** models draw inconsistent icons, and mixed styles (or emoji) are an instant tell.
One pack in one style, used everywhere, reads as designed. The pack also becomes the
reference for any new icon you need later.

**How**
- Iconify (https://icon-sets.iconify.design): 200+ open-source sets, each drawn in one style
  on one grid, with licences per set (MIT, Apache, CC BY - the last needs credit). One icon:
  copy the SVG or fetch `https://api.iconify.design/<prefix>/<name>.svg`. A whole set: there
  is no zip button; use `npm i -D @iconify-json/<prefix>` and `@iconify/tools`'
  `exportToDirectory()` to write the SVG files.
- Flaticon (https://www.flaticon.com): huge, but the free tier is PNG only and requires
  attribution ("designed by <author> from Flaticon"); SVG needs Premium.
- Put the set in `assets/icons/`, name it in DESIGN.md (set, style, stroke width), and use
  `currentColor` so icons follow the theme.

**Prompt**
```
Use only icons from assets/icons/ ([set name], [style, stroke width]). Replace every emoji and
ad-hoc icon in [files]. If we need an icon the set lacks, draw it as SVG on the same grid with
the same stroke and corner style, and add it to the folder.
```

---

## 17. Ask for SVG

**Use when:** you ask an agent for any icon, illustration, chart or diagram.

**Why:** SVG scales to any size without blurring, can be recolored by hand or by token,
can be animated (CSS, GSAP), and stays small. Every graphic becomes editable.

**Prompt**
```
Draw [icon / illustration / diagram] as clean SVG: viewBox [0 0 24 24 or size], fills and
strokes in currentColor or our tokens, parts grouped with ids so we can animate them, no
embedded images, and real text only where it must stay editable.
```

**Done when:** it renders crisp at 16px and 512px and recolors through CSS.

---

## 18. Animated icons with Lordicon (Lottie)

**Use when:** motion carries meaning: success, loading, empty states, onboarding.

**Why:** a Lottie file is an animation stored as JSON, small and crisp, with the motion
already designed. A step up from static SVG where a state change needs to be felt.

**How:** Lordicon (https://lordicon.com) has about 48,000 animated icons, about 9,700 free.
The free licence requires a credit ("Animated icons by Lordicon.com", e.g. in the footer).
Download Lottie JSON, or embed with `<script src="https://cdn.lordicon.com/lordicon.js">`
and `<lord-icon src="https://cdn.lordicon.com/<id>.json" trigger="hover">`, or install
`@lordicon/element` to self-host. Triggers include in, click, hover, loop, morph.

**Prompt**
```
Use this Lordicon Lottie file for the [empty state / success] icon, triggered on [hover / in],
recolored to our tokens. Add the required attribution to the footer, and show a static SVG
instead when prefers-reduced-motion is set.
```

---

## 19. Bookmark Creators Toolbox

**Use when:** you need a type of resource you don't have yet (mockup kits, three.js
effects, logo galleries, animated components).

**How:** Creators Toolbox (https://creatorstoolbox.com/resources) is a free directory of
about 170 design resources, including several in this skill. Use it to find the tool, then
hand the agent the tool itself, not the directory.

---

## Level checklist (Intermediate)

- [ ] Real images or video in the brand's Imagery style (or a working generator skill)
- [ ] Sections built from proven components, restyled only through tokens
- [ ] One icon set, SVG, `currentColor`; no emoji in the UI
- [ ] At most one or two signature effects, with reduced-motion fallbacks
- [ ] Audit run (Impeccable or `slop_check.py`); errors fixed
- [ ] Tone-of-voice skill with a banned-words list
- [ ] Licences and attributions recorded in DESIGN.md

Next: Advanced adds platform rules (20), motion (21), canvases and tweaking (22, 23), video graphics (24) and a design OS (25).
