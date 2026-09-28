# Source video map

**"25 Tricks to Level Up Claude Design in 13 Mins"** - Jay E, RoboNuggets.
https://www.youtube.com/watch?v=_SVU3oC4JX8 - published 27 September 2026, 13:32 long.
This skill summarizes the techniques in its own words and extends them for any agent; it
does not reproduce the video. Watch it for the demos.

## Structure

| Section | Starts | Techniques |
|---|---|---|
| Intro | 00:00 | - |
| Easy | 00:33 | 1-7 |
| Intermediate | 04:22 | 8-19 |
| Advanced | 10:05 | 20-25 |
| Wrap-up | 13:07 | - |

## Where each technique appears (approximate)

| # | Technique | At | # | Technique | At |
|---|---|---|---|---|---|
| 1 | Design system first | 00:33 | 14 | React Bits | 07:41 |
| 2 | 2,000+ real systems (Refero Styles) | 01:08 | 15 | Canvas UI | 08:12 |
| 3 | Shortlist the top three | 01:31 | 16 | One icon pack | 08:30 |
| 4 | Design system as a skill | 02:03 | 17 | Ask for SVG | 08:52 |
| 5 | Real fonts | 02:42 | 18 | Lordicon (Lottie) | 09:13 |
| 6 | Copy from niche leaders | 03:27 | 19 | Creators Toolbox | 09:34 |
| 7 | Mix design systems | 03:52 | 20 | Apple HIG as a skill | 10:14 |
| 8 | Image/video generator | 05:08 | 21 | GSAP | 10:36 |
| 9 | Reference another project | 05:34 | 22 | `/design` in Claude Code | 10:57 |
| 10 | Reference library | 06:02 | 23 | Tweak panel | 11:33 |
| 11 | Impeccable | 06:31 | 24 | Transcript to motion graphics | 11:57 |
| 12 | Tone-of-voice skill | 06:52 | 25 | Design operating system | 12:35 |
| 13 | 21st.dev | 07:23 | | | |

## What was checked, corrected or added (September 2026)

- The auto-captions garble several names. The design-system gallery is **Refero Styles**
  (styles.refero.design); "Key AI" is **Kie.ai**; "Font Joy" is Fontjoy; "Flat Icon" is
  Flaticon; "Lord Icon" is Lordicon; "from Awards" is Awwwards.
- The video says the Claude Design web app can't reach files on your computer unless you
  upload them. Its official tutorial also lets you import local folders; the real limits are
  that it cannot run scripts, use local skills or MCP servers, or generate images and video.
- Reusing a finished project by pasting its URL works in the video but is not in Anthropic's
  docs. The official routes are a published (default) design system or Remix. Claude Code
  cannot open `claude.ai/design` links; use a handoff bundle.
- The tweaks panel is officially described as adjustment sliders Claude generates per design
  (spacing, color, layout) rather than a fixed set of controls.
- `/design` in Claude Code is real: a bundled skill in research preview since August 2026.
  It publishes the canvas as a Design artifact on claude.ai; plan and login requirements apply.
- The one-click reference-capture extension shown is the author's own tool and is not
  publicly listed; any capture tool works.
- Impeccable's "de-slop" pass is spread across several commands (critique, layout, typeset,
  audit, onboard, clarify, polish), plus a standalone detector.
- HyperFrames includes its own transcription (`npx hyperframes transcribe`), so Whisper is
  one option, not a requirement.
- Apple HIG: 44x44 pt is the default control size; the documented minimum is 28x28 pt.
- Creators Toolbox now lists about 170 resources (the video says 150+).
- 21st.dev's free tier became limited (two copies a day) in June 2026; Flaticon's free tier has
  no SVG; Lordicon's free icons need attribution; React Bits and Canvas UI are MIT plus Commons
  Clause; GSAP is free but not open source.
- Added for portability: the design-system template, a zero-install audit script, a tweak
  panel with a bake-back script, a variant board, a word-timestamp script, skill templates
  for brand, voice and platform guidelines, and per-agent install paths.
