# Advanced - systems and motion (techniques 20-25)

Power-user territory. These need a file-system agent (Claude Code, Codex, Cursor, Gemini
CLI, Cowork, Vyotiq...) and some tooling (Python, Node). They pay off when you design often,
ship apps, or make video.

Contents: 20 Platform guidelines as a skill - 21 GSAP motion - 22 Design canvas -
23 Tweak panel - 24 Transcript to motion graphics - 25 Design OS - Level checklist

---

## 20. Platform guidelines as a skill (Apple HIG)

**Use when:** designing app screens (iPhone, iPad, Mac, Watch, visionOS) or any interface
where touch targets, type sizes and platform conventions matter.

**Why:** Apple publishes its whole rulebook for layout, type, touch targets and color for
free. As a skill, the agent follows those rules instead of guessing, and reviews screens
against them.

**How:** start from `assets/guidelines-skill.template.md`. Have the agent read the official
pages at https://developer.apple.com/design/human-interface-guidelines/ (Accessibility,
Layout, Typography, Color, Buttons, Navigation and search, Tab bars, Designing for iOS),
summarize each rule in its own words with a link, keep numbers exact, and date the skill.
Numbers verified in September 2026:
- touch targets: controls default to 44x44 pt, minimum 28x28 pt;
- text: body defaults to 17 pt (22 pt leading at the Large size), floor 11 pt;
- contrast: 4.5:1 for text up to 17 pt, 3:1 for 18 pt and up or bold;
- padding: about 12 pt around bezeled controls, about 24 pt around unbezeled ones.
The same shape works for Material Design 3 (Android), Fluent 2 (Windows) and WCAG 2.2.

**Prompt**
```
Build an apple-hig skill from [path to guidelines-skill.template.md]. Read the official HIG
pages (Accessibility, Layout, Typography, Color, Buttons, Navigation and search, Tab bars,
Designing for iOS), summarize each rule in your own words with its link, keep the numbers
exact, put today's date at the top, and end with a review checklist. Then review [screen]
against it and fix what fails.
```

**Done when:** the skill exists, is dated, and a screen passes its checklist.

**Watch out:** summarize and link; don't paste Apple's text wholesale. Refresh yearly.

---

## 21. GSAP for motion that feels expensive

**Use when:** a site needs scroll-driven sections, text that reveals as you read, pinned
storytelling, or animated SVG.

**Why:** GSAP (GreenSock Animation Platform, https://gsap.com) is the fast, reliable
animation library many top agencies use. Told to use it, agents produce smoother, better
sequenced motion than hand-rolled CSS.

**How:** every GSAP plugin (ScrollTrigger, SplitText, MorphSVG, ScrollSmoother...) has been
free since 3.13 under Webflow's no-charge licence: commercial use is fine, but it is not open
source and may not be used inside no-code animation builders that compete with Webflow.
Install with `npm install gsap` or load from jsDelivr. GSAP publishes official agent skills:
`npx skills add https://github.com/greensock/gsap-skills`.
Rules that keep motion tasteful:
- durations and easing come from DESIGN.md's motion tokens;
- animate `transform` and `opacity`, not layout properties;
- one idea per animation, and reveals run once;
- wrap everything in `gsap.matchMedia()` so reduced-motion users get a fade or nothing;
- in React, use the `useGSAP` hook from `@gsap/react` so animations clean up.

```html
<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/gsap.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/gsap@3.15.0/dist/ScrollTrigger.min.js"></script>
<script>
  gsap.registerPlugin(ScrollTrigger);
  gsap.matchMedia().add('(prefers-reduced-motion: no-preference)', () => {
    gsap.utils.toArray('[data-reveal]').forEach((el) => {
      gsap.from(el, {
        y: 24, opacity: 0, duration: 0.6, ease: 'power2.out',
        scrollTrigger: { trigger: el, start: 'top 85%', once: true },
      });
    });
  });
</script>
```

**Prompt**
```
Add motion with GSAP (ScrollTrigger, and SplitText for headline reveals) to: [list the
moments]. Use our motion tokens, animate only transform and opacity, run each reveal once,
and put everything inside gsap.matchMedia so reduced-motion users get a simple fade.
```

---

## 22. Work on a design canvas

**Use when:** exploring directions, comparing variants, or iterating visually with the user.

**Why:** seeing three directions side by side beats describing one. Canvas tools let the
user point at the thing to change.

**How**
- **Claude Code `/design`** (a bundled skill in research preview since August 2026):
  `/design <brief>` drafts artboards on one canvas, publishes them as a Design artifact on
  claude.ai and prints the link. Open it in a desktop browser, select an element to change
  it (edits save automatically), export artboards as PNG or PDF, then tell Claude which
  option to implement. It runs inside your session, so it works from your project's files
  and existing design system. Requires a Pro, Max, Team or Enterprise plan, signing in with
  `/login` (not an API key), the Anthropic API (not Bedrock, Vertex or Foundry), and an org
  without CMEK, HIPAA or ZDR. Related: `/design-sync` uploads a repo's React design system
  to Claude Design.
- **Claude Design:** a canvas with inline comments, direct text edits and drag, resize and
  align controls. Exports ZIP, PDF, PPTX and standalone HTML, sends to partner tools (Canva
  and others), and hands off a bundle (design files, chat, README) to Claude Code.
- **Any other agent:** write each direction as its own HTML file and open
  `assets/artboards.html?v=a.html,b.html,c.html` (add `&device=mobile` for phone frames,
  `&labels=Calm,Bold,Dense` for names). "Pick" copies a one-line answer to paste back.

**Prompt**
```
Draft 3 distinct directions for [screen] using our DESIGN.md, each as its own file
(a.html, b.html, c.html). Vary [layout / density / type contrast], not just color. Open them
in artboards.html so I can compare them at desktop and mobile sizes, then implement the one I pick.
```

---

## 23. A tweak panel for any page

**Use when:** the design is nearly right and the last 10% is spacing, sizes and color.

**Why:** dragging a slider and seeing the page change beats five rounds of "a bit more
padding". Claude Design has this built in: it generates adjustment sliders for each design.
This skill brings the same loop to every agent and every HTML page.

**How** (`assets/tweak-panel.js` + `scripts/tweak.py`)
1. Make sure the design's values are CSS custom properties on `:root` (technique 1). The
   panel tweaks tokens; hard-coded values stay put.
2. `python scripts/tweak.py inject page.html` inlines the panel (works from `file://`).
   Alternatives: a script tag pointing at `tweak-panel.js`, or paste the file into DevTools.
3. The user adjusts colors, sizes, spacing, fonts and durations. **Hide** mode: click any
   element to hide it (Esc to stop). Alt+Shift+T collapses the panel. Changes persist per page.
4. They press **Save JSON** (or Copy JSON). Agents with a browser can read
   `window.tweaks.export()` directly.
5. `python scripts/tweak.py bake tweaks.json styles.css [page.html]` rewrites the matching
   `:root` / `html` declarations for the color scheme that was on screen, leaves everything
   else byte for byte, lists tokens it could not find, and lists hidden elements for you to
   delete from the source. Add `--dry-run` to preview.
6. `python scripts/tweak.py remove page.html`.
For frameworks (Vite, Next.js, Astro), load the panel with a dev-only script tag and bake
into the tokens file (e.g. `globals.css`). Worth saving as a personal `tweak` skill whose
body is just these steps.

**Prompt**
```
Put the tweak panel on [page] (scripts/tweak.py inject). Tell me when it's ready; I'll adjust
it and save the JSON to [path]. Then bake it into [tokens file], remove the panel, delete any
elements I hid, and show me the diff.
```

---

## 24. Transcript to motion graphics

**Use when:** you recorded a talk, tutorial or video and want animations timed to what you say.

**Why:** graphics that land on the exact word that needs them are what make edited video
feel produced. Word-level timestamps make that precise, and building the graphics from the
design system keeps them from looking vibe-coded.

**How**
1. **Word timestamps.** Either `npx hyperframes transcribe audio.mp3 --model medium.en --language en`
   (HyperFrames; Parakeet on Apple Silicon, whisper.cpp elsewhere) or
   `python scripts/word_timestamps.py talk.mp4` (faster-whisper or openai-whisper). Both
   produce a word array `[{text, start, end}]`; the script also writes `phrases.md`
   (timecoded phrases) and, with `--srt`, subtitles.
2. **Pick the moments.** Read `phrases.md` and choose where a visual helps: numbers, lists,
   named tools, before/after, steps, a claim that needs proof. Skip filler. Write `cues.json`:
   ```json
   [{"id": "c01", "start": 12.40, "end": 15.10, "say": "three tricks", "visual": "3 numbered cards slide in", "type": "list"}]
   ```
3. **Build each cue** as HTML/CSS with GSAP, SVG or Lottie, using DESIGN.md tokens; the
   clip length is `end - start`.
4. **Render.** HyperFrames (https://github.com/heygen-com/hyperframes, Apache-2.0, by HeyGen)
   renders HTML to video deterministically in headless Chrome with FFmpeg:
   `npx hyperframes init my-video`, `npx hyperframes preview`,
   `npx hyperframes render --output out.mp4`. Use WebM with alpha for overlays. Needs Node 22+,
   FFmpeg and Chrome (`npx hyperframes doctor` checks). Its agent skills:
   `npx skills add heygen-com/hyperframes`.
5. **Place** the clips in your editor at the cue times.

**Prompt**
```
Here are words.json and phrases.md for my video. Pick 8-12 moments where a graphic would help
the viewer (numbers, lists, named tools, before/after). Write cues.json with start and end
taken from the transcript, build each cue with our DESIGN.md tokens, render each as a
transparent WebM named by cue id, and give me the list with timestamps.
```

**Watch out:** `word_timestamps.py` needs one engine installed (`pip install faster-whisper`
recommended). Word timings are good to about a tenth of a second; nudge cues by eye in the editor.

---

## 25. Build your design operating system

**Use when:** you design often and keep re-making things you already have.

**Why:** everything you make is a future asset. One indexed library - finished designs,
generated images and videos with their prompts, reusable elements like 3D renders, motion
clips and SVG icons, and references - lets you and the agent reuse before regenerating,
and keeps the look consistent across projects.

**How:** a small folder plus a manifest the agent can query, and a gallery page it keeps current:
```
design-os/
  library.json     one entry per item: id, type, title, tags, file, source or prompt, licence, date, used_in
  designs/  generated/  elements/icons/  elements/motion/  elements/3d/  references/
  index.html       searchable gallery with filters by type and tag
```
Point the brand skill (4) and the reference library (10) at it, and tell agents to search
`library.json` before creating anything new.

**Prompt**
```
Build a local design library in design-os/: scan [folders], write library.json (id, type,
title, tags, file, source or prompt, licence, date), and generate index.html, a searchable
gallery with filters by type and tag. Add a README telling agents to query library.json
before generating new assets, and to add every new asset to it.
```

---

## Level checklist (Advanced)

- [ ] App screens reviewed against a dated platform-guidelines skill
- [ ] Motion built with GSAP, driven by motion tokens, reduced-motion safe
- [ ] Directions compared on a canvas or artboards before building one
- [ ] Final values tuned with the tweak panel and baked into the tokens
- [ ] Video graphics timed from a word-level transcript and a cue sheet
- [ ] A design OS the agent checks before creating new assets
