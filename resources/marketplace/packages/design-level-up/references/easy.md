# Easy - the foundation (techniques 1-7)

Anyone can do these in under an hour, with nothing to install. Done together they put an
agent's output ahead of most AI-made design, because they replace the model's defaults with
decisions: a system, real type, and words that sound like the audience.

Contents: 1 Design system first - 2 Borrow from real systems - 3 Shortlist three -
4 Keep it as a skill - 5 Real fonts - 6 Copy from the niche leaders - 7 Mix systems -
Level checklist

Each technique: **Use when**, **Why**, **How** (per environment), **Prompt**, **Done when**, **Watch out**.
Prompts are starting points: fill the brackets, cut what doesn't apply.

---

## 1. Design system first

**Use when:** always, before the first page, deck or graphic.

**Why:** an agent without a system averages everything it has seen. A system turns that
average into decisions (these two fonts, this orange, this spacing) and every later
technique plugs into it. Written as tokens, it also makes the design tweakable (23) and
portable between agents.

**How**
- *Claude Design:* open Design systems and create one. Describe the business, add fonts,
  logos and assets, or import what already exists: a codebase or repo, Figma or other
  design files, a deck or PDF, screenshots, or a capture of a live site. Claude extracts
  palette, type, components and layout patterns. Publish it to make it the organization's
  default; Remix to edit one. Pick it in the design-system selector when starting a project.
- *File-system agents:* gather the brand material in one folder (`brand/logo.svg`,
  `brand/fonts/`, `brand/deck.pdf`, screenshots). Have the agent read it and write
  `DESIGN.md` from `assets/DESIGN.template.md`, including the CSS custom-property block.
- *Chat only:* paste screenshots or brand notes; ask for the DESIGN.md text and the CSS block.

**Prompt**
```
Build our design system. Business: [what, for whom, the one action we want].
Sources: [files / links / screenshots, or "none - propose one"].
Decide or extract: color roles with light and dark values (check body text contrast is at
least 4.5:1), one display and one body font, a type scale of 6-8 steps, a spacing scale,
radius, one shadow, motion durations and easing, core components with their states, a
line of voice and a few banned words.
Write it as DESIGN.md using the structure in [path to DESIGN.template.md], with the CSS
custom-property block at the end. Mark which values came from our material and which you chose.
```

**Done when:** DESIGN.md exists with front-matter tokens and a `:root` block; two font
families; a type scale; contrast checked; invented values flagged for the user.

**Watch out:** an agent will happily invent a palette and present it as "the brand".
Make it say what it extracted versus what it chose.

---

## 2. Borrow from 2,000+ real design systems

**Use when:** there is no brand yet, or the current one is thin.

**Why:** starting from a system a real product team refined beats starting from nothing.
You get proven proportions (type contrast, spacing rhythm, restraint) for free.

**How:** Refero Styles (https://styles.refero.design) is a free gallery of 2,000+ design
systems taken from real product sites. Each style page offers the system as markdown
("Copy .md"), plus Tailwind v4 `@theme`, CSS variables and design tokens.
1. Open a style you like and copy the markdown (or the CSS variables).
2. Paste it into the agent, or save it as `references/<name>.DESIGN.md`.
3. Ask for the adjustments that make it yours.
Refero also has an official MCP server, but it needs a paid plan. getdesign.md (by
VoltAgent) is a smaller collection of brand DESIGN.md files that works the same way.

**Prompt**
```
Here is the [name] style from Refero Styles: [paste]. Adapt it into our DESIGN.md:
keep its [type contrast / spacing rhythm / density], replace the palette with [our colors or
"a palette that fits: ..."], and swap in fonts we are licensed to use. Keep the section
structure of our template and note under Provenance what came from [name].
```

**Done when:** DESIGN.md is based on a real system, adapted, with provenance noted.

**Watch out:** Refero's markdown does not follow the Google Labs DESIGN.md format, so
normalize it into the template. For anything public, adapt and blend (technique 7) rather
than shipping another company's identity.

---

## 3. Let the agent shortlist the top three

**Use when:** a gallery is too big to browse (Refero has thousands of entries).

**Why:** the agent can scan hundreds of options against a brief faster than you can
scroll. You keep the taste decision; it does the filtering.

**How:** needs web browsing or fetch. Give the gallery link plus a description of the
business and the feeling you want, and ask for three matches with links and reasons.
Without web access, use Refero's MCP (paid) or browse yourself and paste candidates.

**Prompt**
```
Go through https://styles.refero.design and shortlist the 3 design systems closest to us:
[business, audience, 3-5 mood words, things we dislike]. For each give the link, the 2-3
traits that match, and one risk. Don't choose for me; I'll pick or ask you to blend them.
```

**Done when:** three links with reasons; the user picks one (then technique 2) or several
(then technique 7).

---

## 4. Keep the design system as a skill

**Use when:** you use a file-system agent (Claude Code, Cowork, Codex, Cursor, Gemini CLI,
Vyotiq...) or you will design for this brand more than once.

**Why:** a design system inside one web app stays there. As a skill it travels with the
agent to every project, can read local files, run scripts and call tools, and loads on
demand ("make the pricing page in our style"). Most techniques in this skill work in
file-system agents for the same reason.

**How:** copy `assets/brand-skill.template.md` to `<skills folder>/<brand>-design/SKILL.md`,
put DESIGN.md and an `assets/` folder (logo, icons, approved images, fonts only if their
licence allows copying) next to it, and replace the placeholders. Where each agent looks
for skills: `references/environments.md`. The same move works for a public brand you are
studying, e.g. a skill that researches a brand's public site and guidelines and saves
exact colors, type, radius, illustration and motion style - useful for learning and
internal mockups, not for shipping someone else's look.

**Prompt**
```
Create a skill called [brand]-design in [skills folder], starting from [path to
brand-skill.template.md]. Put our DESIGN.md and brand assets beside it. When the skill is
used it should read DESIGN.md first and run its checklist before handing anything over.
Test it by building a small [hero section] with it and show me the result.
```

**Done when:** the skill loads by name, reads DESIGN.md, and its test output uses the tokens.

**Watch out:** the `name` field must match the folder name (lowercase, digits, hyphens).
claude.ai rejects skill names containing "claude" or "anthropic". Never bundle font files
whose licence forbids redistribution.

---

## 5. Real fonts

**Use when:** always. Check this even when you are "only prototyping".

**Why:** type is the fastest tell. Pages left on the model's default (Inter, system UI,
Roboto) read as generated before anyone reads a word.

**How**
- Fontshare (https://www.fontshare.com, by Indian Type Foundry): high-quality free fonts
  such as Satoshi, General Sans and Clash Display. Free for commercial use; self-hosting for
  your own sites and apps is fine, redistributing the files is not (keep them out of public
  repos). Load via `https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap`.
- Fontesk (https://fontesk.com): free fonts from independent designers, but licences vary
  font by font. Read the licence file in each download; prefer the OFL filter, or get the
  font from the designer's own page.
- Google Fonts: everything is open-licensed (mostly OFL).
- Fontjoy (https://fontjoy.com): generates heading + body pairings from Google Fonts.
  There is no export; copy the family names.
- Pick one display face and one body face (three families at most). Record family,
  weights, source and licence in DESIGN.md. In Claude Design, name the fonts in the prompt
  or upload the font files to the design system.

**Prompt**
```
Suggest 3 display + body font pairings for [brand in 3-5 words], using only Fontshare or
Google Fonts, with the licence of each. Render each pairing on our real headline and a
body paragraph side by side so I can compare. After I pick, wire it into the type tokens
and load the fonts with font-display: swap.
```

**Done when:** the chosen fonts actually load (check the network or the rendered page),
tokens are updated, licence recorded.

---

## 6. Copy from the niche leaders, not from AI defaults

**Use when:** the design has any words in it, which is always.

**Why:** perfect visuals lose the audience the moment the copy sounds machine-made. The
fix is to start from what already works in the niche instead of from the model's
marketing voice.

**How:** have the agent study the top five players in the niche and extract patterns:
how headlines are built, which proof they show (numbers, logos, reviews), how calls to
action are phrased, which objections they answer, which words they avoid. Put the
patterns in DESIGN.md (Voice & Copy) and start a banned-words list.

**Prompt**
```
Study the homepages and pricing pages of the top 5 [niche] companies: [names, or find
them]. Report the patterns they share: headline structure, proof, CTA wording, objections
handled, words they avoid. Then write our [section] copy with those patterns in our
voice, add the patterns to DESIGN.md under Voice & Copy, and start banned-words.txt with
any AI-sounding words you notice.
```

**Done when:** patterns are written down; the copy uses specifics (numbers, names, dates);
`scripts/slop_check.py` reports no AI-sounding phrases.

**Watch out:** borrow patterns, never lines. Copying competitors' sentences is both lazy
and risky.

---

## 7. Mix design systems into your own

**Use when:** you like parts of several systems, or a single borrowed one feels like a copy.

**Why:** a deliberate blend reads as original and professional; a straight copy of a
brand you admire reads as a knock-off.

**How:** bring two or three systems into one session (in Claude Design, add the other
design systems to the chat; elsewhere, reference their files), say exactly which traits
come from which, and resolve conflicts in favor of readability.

**Prompt**
```
Merge these into our DESIGN.md: typography from [A], color and motion from [B], layout
density and spacing from [C]. Where they conflict, choose readability. List under
Provenance what came from where, then render one hero and one card with the result.
```

**Done when:** a single blended DESIGN.md with provenance, and a sample render the user approves.

---

## Level checklist (Easy)

- [ ] DESIGN.md exists, with tokens exposed as CSS custom properties
- [ ] Palette has roles, light and dark values, checked contrast
- [ ] One display font and one body font, loaded, licence recorded
- [ ] Voice notes and a banned-words list
- [ ] Provenance says where each part came from
- [ ] Optional: the system saved as a skill (4)

Next: Intermediate adds real assets and polish; start with 11 (audit), 16/17 (icons) and 12 (voice).
