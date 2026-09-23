/**
 * Every screenshot and clip the site shows, and what each one has to show.
 *
 * All of them are real captures of the released application doing real work
 * with a real model; nothing is mocked. A clip is a few seconds of one recorded
 * run of the whole window: the camera starts wide, moves in on the action and
 * back out, and a dip to the window's background marks each skip in time and
 * the point where the loop restarts. Waits are sped up or held on one frame,
 * nothing is reordered, and the only change to a frame is a blur over a
 * username where a path shows one.
 *
 * Images go in src/media/ as <id>.png, or as a pair <id>-light.png and
 * <id>-dark.png (.jpg and .webp work too). Astro resizes them and serves WebP.
 *
 * A clip goes in public/media/ as <id>-light.mp4 and <id>-dark.mp4, each with
 * an optional AV1 .webm beside it, and a poster of the same size in src/media/
 * as <id>-light-poster.png and <id>-dark-poster.png. A single <id>.mp4 with
 * <id>-poster.png works for a clip recorded in one theme only.
 *
 * Until a file arrives, its slot renders a dashed frame naming the file it
 * expects, so a preview shows where everything goes. verify-site.mjs fails on
 * any such frame, which keeps an unfinished page from being published.
 */

export type MediaSlot = {
  kind: 'image' | 'video'
  /** Alt text: what the capture shows, for someone who cannot see it. */
  alt: string
  /** What the missing frame says: the file to supply and what should be in it. */
  file: string
  brief: string
  /** Aspect ratio of the empty frame, before the real file sets its own. */
  ratio: string
}

export const MEDIA: Record<string, MediaSlot> = {
  hero: {
    kind: 'video',
    alt: 'Agent V editing a Rust file in a real repository, running the tests and showing the result.',
    file: 'hero-light.mp4 + hero-dark.mp4, with posters',
    brief: 'A few seconds of a real task: the edit arriving as a diff and the tests passing.',
    ratio: '16 / 10'
  },
  rewind: {
    kind: 'video',
    alt: 'Agent V reverting a chat to before an earlier message, listing the files it restores.',
    file: 'rewind-light.mp4 + rewind-dark.mp4, with posters',
    brief: 'The revert to an earlier message: the dialog listing the files, then the revert.',
    ratio: '16 / 10'
  },
  parallel: {
    kind: 'video',
    alt: 'A main run in Agent V handing work to child agents that run at the same time.',
    file: 'parallel-light.mp4 + parallel-dark.mp4, with posters',
    brief: 'A main run starting a couple of child agents and waiting on them.',
    ratio: '4 / 3'
  },
  approval: {
    kind: 'video',
    alt: 'Agent V asking for approval before it runs a terminal command, and the command starting once it is allowed.',
    file: 'approval-light.mp4 + approval-dark.mp4, with posters',
    brief: 'The approval prompt before a terminal command, and the Allow click.',
    ratio: '4 / 3'
  },
  terminal: {
    kind: 'video',
    alt: 'The agent’s test run streaming into the terminal it shares with you.',
    file: 'terminal-light.mp4 + terminal-dark.mp4, with posters',
    brief: 'The agent’s command output streaming into the terminal panel.',
    ratio: '4 / 3'
  },
  marketplace: {
    kind: 'image',
    alt: 'The Agent V marketplace, listing bundled MCP servers with an Add button beside each one.',
    file: 'marketplace.png',
    brief: 'The Marketplace screen.',
    ratio: '16 / 10'
  }
}
