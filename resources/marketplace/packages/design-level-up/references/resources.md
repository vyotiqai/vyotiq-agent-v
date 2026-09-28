# Resources - links, cost, licence, hand-off

Every external resource the techniques use, checked in September 2026. Free tiers and
licences change; confirm on the site before relying on them for commercial work.
"Hand-off" is the best way to get the resource into an agent.

## Design systems and references

| Resource | What it is | Cost / licence | Hand-off | Technique |
|---|---|---|---|---|
| Refero Styles - https://styles.refero.design | 2,000+ design systems from real product sites (colors, type, spacing, components, do/don'ts) | Free on the web; official MCP needs a paid Refero plan | "Copy .md" on a style page; also Tailwind v4 `@theme`, CSS variables, tokens | 2, 3 |
| getdesign.md (VoltAgent) - https://getdesign.md | Smaller collection of brand DESIGN.md files | Free | Copy a file into the project | 2 |
| Google Labs DESIGN.md spec - https://github.com/google-labs-code/design.md | Open format (alpha): YAML tokens + fixed section order; CLI can lint, diff and export | Apache-2.0 | `npx @google/design.md lint DESIGN.md` | 1 |
| Dribbble - https://dribbble.com | Designer shots and portfolios | Free to browse | Screenshot + URL into the reference library | 10 |
| Awwwards - https://www.awwwards.com | Web design awards and curated galleries | Free to browse | Screenshot + URL | 10 |
| Creators Toolbox - https://creatorstoolbox.com/resources | Directory of ~170 free design resources | Free | Hand the agent the underlying resource | 19 |

## Fonts

| Resource | What it is | Cost / licence | Hand-off | Technique |
|---|---|---|---|---|
| Fontshare - https://www.fontshare.com | Free fonts from Indian Type Foundry (Satoshi, General Sans, Clash Display...) | Free incl. commercial; ITF Free Font License or OFL. Self-host for your own sites and apps; never redistribute (no public repos) | `<link href="https://api.fontshare.com/v2/css?f[]=general-sans@400,500,700&display=swap" rel="stylesheet">` or download + `@font-face` | 5 |
| Fontesk - https://fontesk.com | Aggregator of free fonts from independent designers | Varies per font; read each licence file; no licence file means personal use only. Prefer the OFL filter or the designer's own page | Download, self-host, keep the licence file with the font | 5 |
| Google Fonts - https://fonts.google.com | Open-source font library | Free, mostly OFL | CSS link or self-host | 5 |
| Fontjoy - https://fontjoy.com | Neural-net font pairing over Google Fonts (a 2018 experiment, still online) | Free | Copy the family names; load from Google Fonts | 5 |

## Images, video, components and effects

| Resource | What it is | Cost / licence | Hand-off | Technique |
|---|---|---|---|---|
| Kie.ai - https://kie.ai (docs https://docs.kie.ai) | One API and credit balance for many image, video and audio models | Pay-as-you-go credits; model line-up changes | REST API with a bearer key from `.env`; no official MCP (community ones exist) | 8 |
| 21st.dev - https://21st.dev | 12,000+ community React/Tailwind components, templates, shaders | Freemium: 2 copies/day free when signed in (since June 2026); paid plans | "Copy prompt"; `npx shadcn@latest add "https://21st.dev/r/<author>/<component>"`; 21st MCP | 13 |
| React Bits - https://reactbits.dev | 200+ animated React components | Free, MIT + Commons Clause (no reselling); paid Pro exists | `npx shadcn@latest add @react-bits/<Name>-TS-TW` (JS-CSS, JS-TW, TS-CSS, TS-TW), jsrepo, or copy | 14 |
| Canvas UI - https://canvasui.dev | 35 WebGL/WebGPU effects over live HTML (liquid, glass, shatter, particle reveal...) | Free, MIT + Commons Clause | `npx shadcn@latest add @canvas-ui/<effect>-react` (also Vue, Svelte, vanilla) | 15 |

Canvas UI's live-HTML effects need a Chrome flag or origin-trial token today; other browsers
get a reduced fallback.

## Icons

| Resource | What it is | Cost / licence | Hand-off | Technique |
|---|---|---|---|---|
| Iconify - https://icon-sets.iconify.design | 200+ open-source icon sets, 300k+ icons, one style per set | Free; licence per set (MIT, Apache, CC BY needs credit) | One icon: `https://api.iconify.design/<prefix>/<name>.svg`. Whole set: `npm i -D @iconify-json/<prefix>` + `@iconify/tools` `exportToDirectory()` | 16 |
| Flaticon - https://www.flaticon.com | Very large icon marketplace | Free tier: PNG only, attribution required ("designed by <author> from Flaticon"); Premium adds SVG | Download PNG/SVG into `assets/icons/` | 16 |
| Lordicon - https://lordicon.com | ~48,000 animated icons; ~9,700 free | Free licence needs the credit "Animated icons by Lordicon.com"; free CDN embeds are capped; PRO removes the credit | Lottie JSON; `<script src="https://cdn.lordicon.com/lordicon.js">` + `<lord-icon>`; or `@lordicon/element` | 18 |

## Audits, motion, video

| Resource | What it is | Cost / licence | Hand-off | Technique |
|---|---|---|---|---|
| Impeccable - https://impeccable.style (github.com/pbakaus/impeccable) | Design skill: 24 commands, 61 deterministic detector rules; many agents supported | Apache-2.0 | `npx impeccable install`; Claude Code: `/plugin marketplace add pbakaus/impeccable`; `npx impeccable detect <path> --json` | 11 |
| GSAP - https://gsap.com | Animation library incl. ScrollTrigger, SplitText, MorphSVG | Free (all plugins since 3.13) under Webflow's no-charge licence; not open source | `npm install gsap`; jsDelivr CDN; skills: `npx skills add https://github.com/greensock/gsap-skills` | 21 |
| HyperFrames - https://github.com/heygen-com/hyperframes | HeyGen's "write HTML, render video" framework for agents; built-in transcription | Apache-2.0; needs Node 22+, FFmpeg, Chrome | `npx hyperframes init / preview / render / transcribe`; skills: `npx skills add heygen-com/hyperframes` | 24 |
| faster-whisper - https://github.com/SYSTRAN/faster-whisper | Fast Whisper reimplementation with word timestamps | MIT | `pip install faster-whisper` (used by `scripts/word_timestamps.py`) | 24 |
| openai-whisper - https://github.com/openai/whisper | Original Whisper; `word_timestamps=True` | MIT; needs ffmpeg | `pip install -U openai-whisper` | 24 |
| WhisperX - https://github.com/m-bain/whisperX | Whisper plus forced alignment for tighter word boundaries | BSD-2-Clause | `pip install whisperx` | 24 |

## Guidelines and style guides

| Resource | What it is | Cost | Hand-off | Technique |
|---|---|---|---|---|
| Apple Human Interface Guidelines - https://developer.apple.com/design/human-interface-guidelines/ | Apple's layout, type, touch-target, color and component rules | Free | Summarize into a skill (`assets/guidelines-skill.template.md`) | 20 |
| ASD-STE100 Simplified Technical English - https://www.asd-europe.org/standards-specifications/simplified-technical-english/ | Controlled English: 53 writing rules plus a dictionary | Free PDF after a short form; don't redistribute | Summarize the rules in the tone skill | 12 |
| Google developer documentation style guide - https://developers.google.com/style | Voice, tone and formatting guidance | Free | Link and paraphrase in the tone skill | 12 |
| Apple Style Guide - https://support.apple.com/guide/applestyleguide/welcome/web | Apple's editorial guide for docs and UI copy | Free | Look up specific entries | 12 |

## Not recommended as a dependency

- **"Rubric References"**, the one-click capture extension shown in the video, is the
  author's own tool and is not publicly listed. Any screenshot tool, or an agent with a
  browser, does the same job (technique 10).
