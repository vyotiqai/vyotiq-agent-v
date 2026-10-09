import type { Terminal } from '@xterm/xterm'
import { getPtyOutputBuffers } from './ptyOutputBuffers'

/**
 * What a terminal tab holds, as text: for Find, Copy all output, and handing
 * the output to the agent. Read from xterm's own buffer, so it is what the
 * screen shows (scrollback included), with no escape codes.
 */

/** The xterm of each open tab, by session id; set while it is mounted. */
const liveTerminals = new Map<string, Terminal>()

export function registerTerminal(sessionId: string, term: Terminal): () => void {
  liveTerminals.set(sessionId, term)
  return () => {
    if (liveTerminals.get(sessionId) === term) liveTerminals.delete(sessionId)
  }
}

export function terminalFor(sessionId: string | null): Terminal | null {
  return sessionId ? (liveTerminals.get(sessionId) ?? null) : null
}

/** `ESC [ … letter` and `ESC ] … BEL` sequences, for output read from the raw buffers. */
// eslint-disable-next-line no-control-regex -- matching escape codes is the point
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-_]/g

/**
 * The newest terminal tab's text, for an @Terminal mention: the shown xterm
 * when one is open, else what the session wrote, its escape codes removed.
 */
export function latestTerminalText(raw: ReadonlyMap<string, string> = getPtyOutputBuffers()): { title: string | null; text: string } | null {
  const live = [...liveTerminals.values()].at(-1)
  if (live) {
    const text = bufferText(bufferLines(live))
    if (text) return { title: null, text }
  }
  const last = [...raw.values()].at(-1)
  if (!last) return null
  const text = bufferText(last.replace(ANSI_RE, '').replace(/\r\n?/g, '\n').split('\n'))
  return text ? { title: null, text } : null
}

/** Every line in the buffer, scrollback first; a wrapped line stays its screen rows. */
export function bufferLines(term: Pick<Terminal, 'buffer'>): string[] {
  const buffer = term.buffer.active
  const lines: string[] = []
  for (let i = 0; i < buffer.length; i += 1) lines.push(buffer.getLine(i)?.translateToString(true) ?? '')
  return lines
}

/** The lines as one text: trailing spaces and the empty rows under the prompt dropped. */
export function bufferText(lines: readonly string[]): string {
  const trimmed = lines.map((line) => line.trimEnd())
  while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') trimmed.pop()
  return trimmed.join('\n')
}

export type TerminalMatch = { row: number; col: number; length: number }

/** Each place `query` appears, ignoring case, top to bottom. */
export function findInLines(lines: readonly string[], query: string): TerminalMatch[] {
  const needle = query.toLowerCase()
  if (!needle) return []
  const matches: TerminalMatch[] = []
  lines.forEach((line, row) => {
    const hay = line.toLowerCase()
    let at = hay.indexOf(needle)
    while (at !== -1) {
      matches.push({ row, col: at, length: needle.length })
      at = hay.indexOf(needle, at + needle.length)
    }
  })
  return matches
}

/** How much output goes to the agent: the end of it, where the error usually is. */
export const ASK_OUTPUT_MAX_LINES = 200
export const ASK_OUTPUT_MAX_CHARS = 12_000

/** An instruction carrying a terminal's output (or the selected part of it) for the agent to read. */
export function askAboutOutputInstruction(text: string, opts: { shell?: string | null; selected?: boolean } = {}): string {
  let lines = text.split('\n')
  let cut = false
  if (lines.length > ASK_OUTPUT_MAX_LINES) {
    lines = lines.slice(-ASK_OUTPUT_MAX_LINES)
    cut = true
  }
  let body = lines.join('\n')
  if (body.length > ASK_OUTPUT_MAX_CHARS) {
    body = body.slice(-ASK_OUTPUT_MAX_CHARS)
    cut = true
  }
  const where = opts.shell ? `my ${opts.shell} terminal` : 'my terminal'
  const what = opts.selected ? `This is from ${where}` : cut ? `This is the end of the output in ${where}` : `This is the output in ${where}`
  const fence = body.includes('```') ? '````' : '```'
  return `${what}. What does it mean, and what should I do about it?\n\n${fence}text\n${body}\n${fence}`
}
