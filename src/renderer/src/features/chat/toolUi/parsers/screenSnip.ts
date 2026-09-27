import type { UiToolRow } from '@shared/transcript'

export type ScreenSnipData = {
  /** `window "Title"` or `display 0 (1920x1080, primary)`. */
  source: string
  /** Uncropped snip size, the space a region is measured in. */
  space: string
  region: string
  /** `3 frames over 1004ms`, empty for a single snip. */
  burst: string
  /** list=true output: the window titles, unquoted. */
  windows: string[]
  displays: string[]
}

function lineValue(lines: string[], prefix: string): string {
  const line = lines.find((l) => l.startsWith(prefix))
  return line ? line.slice(prefix.length).trim() : ''
}

function unquote(title: string): string {
  try {
    const parsed: unknown = JSON.parse(title)
    return typeof parsed === 'string' ? parsed : title
  } catch {
    return title
  }
}

export function parseScreenSnipData(tool: Pick<UiToolRow, 'content'>): ScreenSnipData {
  const lines = (tool.content ?? '').split(/\r?\n/)
  const space = /^(\d+x\d+)/.exec(lineValue(lines, 'Snip space:'))?.[1] ?? ''
  const frames = lineValue(lines, 'Frames:')
  const frameMatch = /^(\d+) at .*\+(\d+)ms$/.exec(frames)
  const burst = frameMatch ? `${frameMatch[1]} frames over ${frameMatch[2]}ms` : ''
  const windows: string[] = []
  const displays: string[] = []
  let section: 'windows' | 'displays' | null = null
  for (const line of lines) {
    if (line.startsWith('Displays:')) section = 'displays'
    else if (line.startsWith('Open windows')) section = 'windows'
    else if (line.startsWith('- ') && section) {
      const item = line.slice(2).trim()
      if (item === '(none)') continue
      if (section === 'windows') windows.push(unquote(item))
      else displays.push(item)
    } else if (!line.trim()) continue
    else section = null
  }
  return {
    source: lineValue(lines, 'Source:'),
    space,
    region: lineValue(lines, 'Region:'),
    burst,
    windows,
    displays
  }
}
