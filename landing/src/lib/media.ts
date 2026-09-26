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
 *
 * Each capture sits inset on a detail of one painting: William Trost Richards,
 * "Lake Squam and the Sandwich Mountains" (1872), The Metropolitan Museum of
 * Art, public domain (CC0): https://www.metmuseum.org/art/collection/search/11896
 * src/art/ holds the whole painting and the details cut from it.
 */

export type MediaSlot = {
  kind: 'image' | 'video'
  /** Alt text: what the capture shows, for someone who cannot see it. */
  alt: string
  /** The painting behind it: a .jpg in src/art/, named without the extension. */
  art: string
  /** What the missing frame says: the file to supply and what should be in it. */
  file: string
  brief: string
  /** Aspect ratio of the empty frame, before the real file sets its own. */
  ratio: string
}

export const MEDIA: Record<string, MediaSlot> = {
  hero: {
    kind: 'image',
    alt: 'Agent V working through a real codebase: it has written a plan and started four instances that run in parallel, with the repository’s uncommitted changes open beside it.',
    art: 'lake-squam',
    file: 'hero.png',
    brief: 'The whole window during a real run: the plan, the instances running in parallel and the Changes panel.',
    ratio: '16 / 10'
  },
  rewind: {
    kind: 'video',
    alt: 'Agent V reverting a chat to before an earlier message, listing the files it restores.',
    art: 'lake-squam-lake',
    file: 'rewind-light.mp4 + rewind-dark.mp4, with posters',
    brief: 'The revert to an earlier message: the dialog listing the files, then the revert.',
    ratio: '16 / 10'
  },
  parallel: {
    kind: 'video',
    alt: 'A main run in Agent V handing work to child agents that run at the same time.',
    art: 'lake-squam-trees',
    file: 'parallel-light.mp4 + parallel-dark.mp4, with posters',
    brief: 'A main run starting a couple of child agents and waiting on them.',
    ratio: '4 / 3'
  },
  approval: {
    kind: 'video',
    alt: 'Agent V asking for approval before it runs a terminal command, and the command starting once it is allowed.',
    art: 'lake-squam-sky',
    file: 'approval-light.mp4 + approval-dark.mp4, with posters',
    brief: 'The approval prompt before a terminal command, and the Allow click.',
    ratio: '4 / 3'
  },
  terminal: {
    kind: 'video',
    alt: 'The agent’s test run streaming into the terminal it shares with you.',
    art: 'lake-squam-island',
    file: 'terminal-light.mp4 + terminal-dark.mp4, with posters',
    brief: 'The agent’s command output streaming into the terminal panel.',
    ratio: '4 / 3'
  },
  marketplace: {
    kind: 'image',
    alt: 'The Agent V marketplace, listing bundled MCP servers with an Add button beside each one.',
    art: 'lake-squam-wide',
    file: 'marketplace.png',
    brief: 'The Marketplace screen.',
    ratio: '16 / 10'
  }
}
