/**
 * Turning the agent's written text into something worth hearing, and cutting
 * it into sentence-sized pieces for text-to-speech (docs/voice-mode.md §8.3,
 * §8.5). Pure functions only: no I/O, no clock.
 */

const FENCE_RE = /```[^\n]*\n[\s\S]*?(?:```|$)/g
const URL_RE = /\bhttps?:\/\/[^\s)>\]]+/g
const LINK_RE = /!?\[([^\]]*)\]\([^)]*\)/g
const INLINE_CODE_RE = /`([^`\n]+)`/g
/** A path-looking token: has a slash or backslash and ends in a file extension. */
const PATH_RE = /(?:[\w.-]+[\\/])+([\w-]+)(?:\.[\w]+)+(?::\d+(?::\d+)?)?/g
const EMOJI_RE = /\p{Extended_Pictographic}️?/gu
/** Vendor expressiveness tags like [laughs] or [whispers]; unused in v1 (D-08). */
const BRACKET_TAG_RE = /\[[a-z][a-z ]{0,20}\]/g

export const CODE_ON_SCREEN = 'I’ve put the code on screen.'
export const DETAILS_ON_SCREEN = 'The details are on screen.'

/** `runAgentLoop` → "run agent loop"; long or odd identifiers are kept as written. */
export function speakIdentifier(id: string): string {
  if (/[\\/]/.test(id) || /\.\w{1,6}$/.test(id)) return basenameWithoutExt(id)
  if (!/^[A-Za-z_][\w]*$/.test(id)) return id
  const words = id
    .replace(/_+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
  if (words.length > 4) return id
  return words.map((w) => (/^[A-Z0-9]+$/.test(w) ? w : w.toLowerCase())).join(' ')
}

function basenameWithoutExt(path: string): string {
  const withoutLine = path.replace(/:\d+(?::\d+)?$/, '')
  const base = withoutLine.split(/[\\/]/).filter(Boolean).pop() ?? withoutLine
  const dot = base.indexOf('.')
  return dot > 0 ? base.slice(0, dot) : base
}

function endsSentence(line: string): boolean {
  return /[.!?:;]["'”’)]*$/.test(line)
}

/**
 * Markdown and code-heavy text → plain speakable prose. Code blocks and
 * tables are dropped (they belong on screen), paths become their file's
 * name, links their text, URLs a pointer to the screen.
 */
export function toSpeakable(markdown: string): string {
  const hadCode = /```/.test(markdown)
  let text = markdown.replace(/\r\n?/g, '\n').replace(FENCE_RE, '\n')
  text = text.replace(LINK_RE, (_m, label: string) => label)
  text = text.replace(URL_RE, 'a link on screen')
  text = text.replace(INLINE_CODE_RE, (_m, code: string) => speakIdentifier(code.trim()))
  text = text.replace(PATH_RE, (_m, base: string) => base)

  const lines: string[] = []
  for (const raw of text.split('\n')) {
    let line = raw.trim()
    if (!line) continue
    if (/^\|/.test(line) || /^[-:|\s]+$/.test(line)) continue // tables, rules
    line = line
      .replace(/^#{1,6}\s+/, '')
      .replace(/^>\s?/, '')
      .replace(/^(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/, '')
    if (!line) continue
    lines.push(line)
  }
  text = lines.map((l) => (endsSentence(l) ? l : `${l}.`)).join(' ')

  text = text
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[\s(])[*_](\S[^*_]*?)[*_](?=[\s).,!?;:]|$)/g, '$1$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(BRACKET_TAG_RE, '')
    .replace(EMOJI_RE, '')
    .replace(/[<>{}[\]|#`*]/g, '')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([.!?])\.+/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim()

  if (!text && hadCode) return CODE_ON_SCREEN
  return text
}

const ABBREVIATIONS = new Set(['e.g', 'i.e', 'vs', 'etc', 'mr', 'mrs', 'ms', 'dr', 'no', 'approx', 'cf', 'v'])

function isAbbreviationBefore(text: string, dotIndex: number): boolean {
  const before = text.slice(0, dotIndex)
  const word = /([A-Za-z.]+)$/.exec(before)?.[1]?.toLowerCase()
  if (!word) return false
  return ABBREVIATIONS.has(word) || /^[a-z]$/.test(word)
}

/** Sentence boundary: the index just past the punctuation, or -1. */
function findBoundary(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\n') return i + 1
    if (ch !== '.' && ch !== '!' && ch !== '?') continue
    let end = i + 1
    while (end < text.length && /[.!?"'”’)]/.test(text[end] ?? '')) end++
    if (end >= text.length) return -1 // can't tell yet: wait for what follows
    if (!/\s/.test(text[end] ?? '')) continue // "1.2.0", "loop.ts"
    if (ch === '.' && isAbbreviationBefore(text, i)) continue
    return end
  }
  return -1
}

/**
 * Cuts streamed text into pieces for text-to-speech. The first piece may be
 * cut early at a comma once it is long enough, so audio starts sooner; after
 * that, whole sentences only, for natural prosody.
 */
export class SentenceSplitter {
  private buffer = ''
  private emittedAny = false

  constructor(private readonly firstChunkMinChars = 40) {}

  push(text: string): string[] {
    this.buffer += text
    const out: string[] = []
    for (;;) {
      const cut = findBoundary(this.buffer, 0)
      if (cut !== -1) {
        this.take(cut, out)
        continue
      }
      if (!this.emittedAny) {
        const early = this.earlyCut()
        if (early !== -1) {
          this.take(early, out)
          continue
        }
      }
      break
    }
    return out
  }

  /** The text is complete: whatever is left is the last piece. */
  flush(): string[] {
    const rest = this.buffer.trim()
    this.buffer = ''
    if (!rest) return []
    this.emittedAny = true
    return [rest]
  }

  private take(cut: number, out: string[]): void {
    const piece = this.buffer.slice(0, cut).trim()
    this.buffer = this.buffer.slice(cut)
    if (piece) {
      out.push(piece)
      this.emittedAny = true
    }
  }

  private earlyCut(): number {
    if (this.buffer.length < this.firstChunkMinChars) return -1
    const re = /[,;:—–]\s/g
    let best = -1
    for (let m = re.exec(this.buffer); m; m = re.exec(this.buffer)) {
      if (m.index + 1 >= this.firstChunkMinChars) {
        best = m.index + 1
        break
      }
    }
    return best
  }
}

/**
 * What to say when the model didn't open its answer with a `<spoken>` block:
 * the first few sentences of the answer, made speakable, then a pointer to
 * the screen if anything was left out (§8.2).
 */
export function fallbackSummary(answer: string, maxSentences = 3, maxChars = 400): string {
  const speakable = toSpeakable(answer)
  if (!speakable) return ''
  const splitter = new SentenceSplitter(Number.POSITIVE_INFINITY)
  const sentences = [...splitter.push(speakable), ...splitter.flush()]
  const kept: string[] = []
  let chars = 0
  for (const s of sentences) {
    if (kept.length >= maxSentences || (kept.length > 0 && chars + s.length > maxChars)) break
    kept.push(s)
    chars += s.length + 1
  }
  if (kept.length === 0) kept.push(speakable.slice(0, maxChars).replace(/\s+\S*$/, '') + '…')
  const truncated = kept.length < sentences.length || speakable.length > chars
  const spoken = kept.join(' ')
  const needsPointer = truncated || /```|^\s*\|/m.test(answer)
  return needsPointer && spoken !== CODE_ON_SCREEN ? `${spoken} ${DETAILS_ON_SCREEN}` : spoken
}

const STOP_PHRASES = new Set([
  'stop',
  'cancel',
  'never mind',
  'nevermind',
  'stop it',
  'stop that',
  'cancel that',
  'stop stop',
  'abort'
])

/**
 * A whole utterance that means "stop the run" (§6.3). Exact match on the
 * normalised utterance only, so "stop the timer from firing twice" is an
 * instruction, not a cancel.
 */
export function isStopPhrase(utterance: string): boolean {
  const norm = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return STOP_PHRASES.has(norm)
}
