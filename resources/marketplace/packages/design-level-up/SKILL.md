---
name: design-level-up
description: Make AI-built design look professional instead of vibe-coded - websites, landing pages, app and UI screens, dashboards, slides, one-pagers, social graphics, icons and motion graphics. Offers 25 techniques in three levels the user picks from - Easy (design systems, real fonts, researched copy, mixing styles), Intermediate (image and video generators, component libraries, icon packs, SVG and Lottie, de-slop audits, tone-of-voice skills) and Advanced (platform guidelines like Apple HIG, GSAP motion, design canvases, live tweak panels, transcript-to-motion-graphics, a personal design OS). Use this skill whenever the user asks to design, redesign, restyle, polish or de-slop an interface or visual, build or import a design system or brand kit, choose fonts, icons, colors or animations, make output look less AI-generated, or turn a talk or video into animations, even if they never say "design system". Works in Claude Code, Claude Design, Cowork, Codex, Cursor, Gemini CLI, Vyotiq and other agents.
compatibility: Any agent that reads Agent Skills (SKILL.md). Scripts need Python 3.9+ (standard library only). The tweak panel and artboards need a browser. Optional extras - Node 22+ for Impeccable, HyperFrames or GSAP via npm; faster-whisper or openai-whisper for transcripts.
metadata:
  version: "1.0.0"
  source: "https://www.youtube.com/watch?v=_SVU3oC4JX8"
---

# Design Level-Up

Agents design from defaults: the average font, the average palette, the average sentence.
That average is what people recognize as "made by AI". This skill replaces defaults with
decisions, one technique at a time, and lets the user choose how far to go.

The 25 techniques come from "25 Tricks to Level Up Claude Design in 13 Mins" (Jay E,
RoboNuggets, 27 Sep 2026). Each one was checked against official docs in September 2026
and rewritten so it works in any agent, not only Claude Design. Corrections to the video
are listed in `references/source-video-map.md`.

## Instructions

The flow at a glance:

0. Check what your environment can do.
1. Offer the level menu once, or pick for the user when you can't ask.
2. Lay the foundation (a design system) if there isn't one.
3. Run the chosen techniques from the tier playbook.
4. Verify before you hand anything over.
5. Deliver, and suggest the next techniques worth adding.

## Step 0 - Know your environment

What you can do depends on where you run. Check quickly, then offer only what works.

| You have | You can run | If you don't |
|---|---|---|
| Files + shell (Claude Code, Codex, Cursor, Gemini CLI, Cowork, Vyotiq, OpenCode) | Everything, including skills, scripts, npm tools | - |
| Web access (browse or fetch) | Galleries, niche research, reference capture (2, 3, 6, 10) | Ask the user to paste links, text or screenshots |
| A design canvas (Claude Design; `/design` in Claude Code) | Native canvas work (22) and built-in tweak sliders (23) | `assets/artboards.html` and `assets/tweak-panel.js` |
| Chat only | Code blocks, SVG, DESIGN.md text, prompts | Say which techniques need files or a shell |

Claude Design runs in the browser: it can import what the user attaches (files, folders,
a repo, Figma, a URL capture) but it cannot run scripts, use local skills or MCP servers,
or generate raster images. Details per agent, and where each one keeps skills, are in
`references/environments.md`.

## Step 1 - Offer the menu

Ask once, briefly, then get to work. Skip the question when the user already named a
level or techniques. If you cannot ask (an autonomous run or a subagent), choose **Auto**
and say which techniques you picked and why.

Keep the question short: show the level table plus your recommended picks for this task
(e.g. "Auto for a landing page: 1, 5, 6, 16, 11"). Show a level's numbered techniques when
the user picks that level or wants to choose individually. If your agent has a structured
question tool, offer the four levels with multi-select.

Match effort to the ask. A level is a menu, not a checklist: when the user says "simple" or
"quick", or the task is small, run the core of the level (Easy: 1, 5, 6; Intermediate: 11,
16 or 17, 12) and offer the rest at the end instead of doing everything. Research-heavy
techniques (2, 3, 6, 10) are worth their time for a new brand, not for a one-off page.

| Level | What you get | Time | Needs |
|---|---|---|---|
| **Easy** (1-7) | A real design system: tokens, fonts, voice. Beats most AI output on its own. | 15-45 min | Nothing to install |
| **Intermediate** (8-19) | Real assets and polish: images, proven components, one icon style, audits, a voice skill | 1-3 h | Free libraries; an API key for images |
| **Advanced** (20-25) | Systems and motion: platform rules, GSAP, canvases, tweak panels, video graphics, a design OS | half a day+ | Node/Python tooling |
| **Auto** (recommended) | You pick the best set for this task | - | - |

Levels build on each other: Intermediate and Advanced assume the Easy foundation (at least
technique 1). Users can mix freely, e.g. "Easy, plus 16, 17 and 21".

### The 25 techniques

**Easy - foundation** (playbook: `references/easy.md`)
1. **Design system first** - build or extract DESIGN.md with tokens before any page.
2. **Borrow from 2,000+ real systems** - start from a Refero Styles system instead of a blank page.
3. **Let the agent shortlist three** - it browses the gallery and returns the 3 closest matches.
4. **Keep the system as a skill** - so it travels to every project and agent.
5. **Real fonts** - a display + body pair from Fontshare or Google Fonts, never the default.
6. **Copy from the niche leaders** - study the top 5 players' patterns, then write in your voice.
7. **Mix systems into your own** - type from one, color and motion from another.

**Intermediate - assets and polish** (playbook: `references/intermediate.md`)
8. **Connect an image/video generator** - Kie.ai or any provider, wrapped as a skill.
9. **Reuse a finished project** - start new work from a past project's system and assets.
10. **Reference library** - screenshots + notes the agent can search.
11. **De-slop audit** - Impeccable, or `scripts/slop_check.py` with no install.
12. **Tone-of-voice skill** - your samples, banned words, and style rule sets.
13. **21st.dev components** - proven sections, restyled with your tokens.
14. **React Bits** - one signature animated component.
15. **Canvas UI** - a WebGL/WebGPU effect for one moment.
16. **One icon pack, one style** - from Iconify; no emoji, no mixed sets.
17. **Ask for SVG** - crisp, editable, animatable graphics.
18. **Animated icons** - Lordicon Lottie files where motion carries meaning.
19. **Creators Toolbox** - a directory for finding the next resource.

**Advanced - systems and motion** (playbook: `references/advanced.md`)
20. **Platform guidelines as a skill** - Apple HIG (or Material, Fluent, WCAG) rules on tap.
21. **GSAP motion** - scroll-driven sections and text reveals that respect reduced motion.
22. **Design canvas** - `/design` in Claude Code, Claude Design, or `assets/artboards.html`.
23. **Tweak panel** - live sliders on any page, then bake the values back into the source.
24. **Transcript to motion graphics** - word timestamps, a cue sheet, rendered clips.
25. **Design OS** - one indexed library of everything visual you make.

### Auto picks

| Task | Start with | Offer next |
|---|---|---|
| Landing or marketing page | 1 (+2, 3 if there is no brand yet), 5, 6, 16 or 17, 11 | 21, 23, 13 |
| App or dashboard screen | 1, 5, 20, 16 or 17, 11 | 22, 23 |
| Slides, one-pager, social graphic | 1, 5, 6, 17 | 8, 12 |
| New brand from scratch | 1, 2, 3, 7, 5, 4 | 12, 10 |
| Polish an existing site | 11 first, then 5, 6, 16 or 17 | 23, 21 |
| Motion or video graphics | 1, 21, 24 | 18, 25 |
| Ongoing or team design work | 4, 9, 12 | 25, 10 |

## Step 2 - Foundation first

Every technique plugs into a design system: fonts go into its type tokens, components are
restyled through its colors, motion uses its durations, the tweak panel edits its
variables. Without one, each fix is a one-off and the next page drifts back to defaults.

If no system exists, make a minimal one before anything else (about five minutes):
color roles with light and dark values, one display and one body font, a type scale, a
spacing scale, radius, shadow, motion durations, a line of voice and a few banned words.
Use `assets/DESIGN.template.md` for the shape and express the tokens as CSS custom
properties on `:root`. When the brand already exists, extract instead of inventing
(technique 1), and tell the user which values you extracted and which you chose.

## Step 3 - Run the techniques

Read only the tier file you need: `references/easy.md`, `references/intermediate.md`,
`references/advanced.md`. Each technique there has: when to use it, how to do it in each
environment, a ready prompt, what "done" looks like, and the caveats (licences, limits).
Record what you decided in DESIGN.md (the Provenance section) so the next agent, or the
next session, starts from the same place. Resource links, costs and licences are in
`references/resources.md`.

## Step 4 - Verify before you hand over

Generated design fails in ways you only see rendered, so look before you ship:

- Render it and look at 390px and 1440px wide, in light and dark. Use a screenshot or
  the browser if you have one.
- Run `python scripts/slop_check.py <files or folder>`, adding
  `--banned-words banned-words.txt` when a tone skill exists. Fix every error; treat
  warnings as a checklist. If Impeccable is installed, `npx impeccable detect <path>` goes deeper.
- Check the floor: body text contrast 4.5:1, a visible focus ring, alt text,
  targets at least 44px, and motion wrapped in `prefers-reduced-motion`.
- Offering several directions? Put them in `assets/artboards.html` so the user can compare and pick.
- Fine-tuning with the user? Use the tweak loop:
  `python scripts/tweak.py inject page.html`, the user adjusts and presses Save JSON, then
  `python scripts/tweak.py bake tweaks.json styles.css` and `python scripts/tweak.py remove page.html`.

## Step 5 - Deliver

Say what level and which techniques you applied, list the files you created or changed,
note anything the user must check themselves (licences, API keys, brand approvals), and
suggest the 2-3 techniques that would add the most next, by number.

## Guardrails

- **Licences travel with assets.** Fontshare fonts must not be redistributed (keep them out
  of public repos); Fontesk licences vary per font; Flaticon's free tier needs attribution
  and has no SVG; Lordicon's free icons need a credit; React Bits and Canvas UI are MIT plus
  Commons Clause; GSAP is free but not open source. Write the terms into DESIGN.md.
- **Learn from brands, don't clone them.** Real systems are great references; for anything
  public, blend and adapt (technique 7) rather than shipping someone else's identity.
- **Keep secrets out of chat.** API keys go in `.env` or the agent's secret store, never
  in prompts, logs or commits.
- **Vet third-party code.** Install skills and MCP servers from their official repos, read
  what they run, and prefer official integrations over community ones.
- **Be straight about limits.** If the environment can't do something (Claude Design
  doesn't generate images), say so and offer the technique that covers it.
- **Accessibility is not optional**, at any level.

## Files in this skill

Paths are relative to this skill's folder; resolve them against wherever the skill is installed.
In Vyotiq, loading the skill prints its directory: run the scripts from there
(`python "<skill directory>/scripts/slop_check.py" ...`) and read the reference files with
the Skill tool plus a relative path, e.g. `references/easy.md`.

| Path | Use it for |
|---|---|
| `references/easy.md` | Techniques 1-7, step by step |
| `references/intermediate.md` | Techniques 8-19, step by step |
| `references/advanced.md` | Techniques 20-25, step by step |
| `references/resources.md` | Every external resource: link, cost, licence, how to hand it to an agent |
| `references/environments.md` | Claude Design vs file-system agents vs chat; where each agent keeps skills |
| `references/source-video-map.md` | The video's structure, timestamps, and what was corrected |
| `scripts/slop_check.py` | No-install audit for default fonts, color sprawl, AI copy, emoji icons, a11y basics |
| `scripts/tweak.py` | Inject/remove the tweak panel; bake exported values into CSS |
| `scripts/word_timestamps.py` | Word-level transcript + timecoded phrases for motion graphics |
| `assets/DESIGN.template.md` | Design system file (tokens, sections, CSS variables) |
| `assets/brand-skill.template.md` | Turn a design system into its own skill (technique 4) |
| `assets/tone-skill.template.md` | Tone-of-voice skill (technique 12) |
| `assets/guidelines-skill.template.md` | Platform guidelines skill, e.g. Apple HIG (technique 20) |
| `assets/tweak-panel.js` | Drop-in live token controls for any page (technique 23) |
| `assets/artboards.html` | Side-by-side variant board for agents without a canvas (technique 22) |
