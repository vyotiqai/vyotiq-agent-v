# Environments - what works where

The techniques were demonstrated in Claude Design, but most of them work better in an agent
that can read files and run commands. Use this to decide what to offer and how.

## Capability matrix

| Technique | Claude Design (web) | File-system agents (Claude Code, Cowork, Codex, Cursor, Gemini CLI, Copilot, OpenCode, Vyotiq) | Chat only |
|---|---|---|---|
| 1 Design system | Built in (Design systems, import, publish) | DESIGN.md + CSS tokens | DESIGN.md text |
| 2-3 Borrow / shortlist | Paste a Refero style | Browse or fetch, then save the file | Paste |
| 4 System as a skill | - (org default design system instead) | Yes | - |
| 5 Fonts | Name them or upload font files | Load or self-host | Code only |
| 6 Niche copy research | With web access | Yes | Paste competitor text |
| 7 Mix systems | Add systems to the chat | Reference files | Paste |
| 8 Image/video generator | Generate elsewhere, upload | API + skill | - |
| 9 Reuse a project | Project URL (unofficial) or published system | Point at the folder or session | - |
| 10 Reference library | Upload screenshots | Folder + index, agent can capture | - |
| 11 De-slop audit | Ask for a critique | Impeccable or `slop_check.py` | Ask for a critique |
| 12 Tone skill | - (keep a voice doc in the design system) | Yes | Paste the voice doc |
| 13-15 Components, effects | Paste code | Install via CLI | Paste code |
| 16-18 Icons, SVG, Lottie | Upload a pack, ask for SVG | Pack in `assets/icons/` | SVG in chat |
| 20 Guidelines skill | - | Yes | Paste the checklist |
| 21 GSAP | Ask for it in code | Yes | Code only |
| 22 Canvas | Native | `/design` (Claude Code) or `artboards.html` | - |
| 23 Tweak panel | Native adjustment sliders | `tweak-panel.js` + `tweak.py` | - |
| 24 Transcript to motion | - | Yes (HyperFrames or `word_timestamps.py`) | - |
| 25 Design OS | - | Yes | - |

## Claude Design facts (official, September 2026)

- Anthropic Labs product at https://claude.ai/design, launched 17 April 2026, in beta on the
  Pro, Max, Team and Enterprise plans (Enterprise owners must enable it). Also reachable as an
  artifact type from chat and from Claude Code.
- Design systems come from a codebase or repo, Figma or design files, decks and PDFs, logos,
  palettes and fonts, screenshots, or a web capture. Publishing makes one the org default;
  Remix edits one.
- Editing: inline comments, direct text edits, drag/resize/align, and adjustment sliders
  Claude generates for each design (spacing, color, layout).
- Output: ZIP, PDF, PPTX, standalone HTML, partner tools (Canva and others), org sharing
  (view or edit), and a handoff bundle to Claude Code (local or web).
- Limits: it imports what you attach but cannot run your scripts, use local skills or MCP
  servers, or generate photos, illustrations or video. No version history yet; large repos
  are slow (link specific folders).

## Claude Code `/design`

A bundled skill in research preview (since August 2026, v2.1.265+ in current docs).
`/design <brief>` drafts artboards on a canvas, publishes them as a Design artifact on
claude.ai, and prints the link; select elements there to edit, export PNG or PDF, then tell
Claude which to implement. Needs a Pro, Max, Team or Enterprise login via `/login`, the
Anthropic API (not Bedrock, Vertex or Foundry), and no CMEK, HIPAA or ZDR on the org.
`/design-sync` converts a repo's React design system and uploads it to Claude Design.

## Where agents keep skills

Install this skill by copying the `design-level-up` folder into one of these.

| Agent | Project folder | Personal folder |
|---|---|---|
| Claude Code | `.claude/skills/` | `~/.claude/skills/` |
| claude.ai, Claude Desktop, Cowork | - | Upload the folder as a ZIP (Customize > Skills; code execution on) |
| Codex (and ChatGPT) | `.agents/skills/` | `~/.agents/skills/` |
| Cursor | `.agents/skills/` or `.cursor/skills/` | `~/.agents/skills/` or `~/.cursor/skills/` |
| Gemini CLI | `.gemini/skills/` or `.agents/skills/` | `~/.gemini/skills/` or `~/.agents/skills/` |
| GitHub Copilot / VS Code | `.github/skills/`, `.claude/skills/` or `.agents/skills/` | `~/.copilot/skills/` or `~/.agents/skills/` |
| OpenCode | `.opencode/skills/`, `.claude/skills/` or `.agents/skills/` | `~/.config/opencode/skills/` |
| Vyotiq | `.vyotiq/skills/` or `.cursor/skills/` | `~/.vyotiq/skills/` |

For the widest reach in a repo, put skills in both `.agents/skills/` and `.claude/skills/`.
Skills you write for claude.ai must not use "claude" or "anthropic" in their `name`, and
should stick to the standard frontmatter fields (name, description, license, compatibility,
metadata, allowed-tools).

## Agents without skill support

Paste the body of SKILL.md into the agent's rules file (for example `AGENTS.md`, a project
rules file, or a custom instruction), keep the `references/`, `scripts/` and `assets/` folders
in the repo, and tell the agent where they are. The scripts are plain Python and run anywhere.
