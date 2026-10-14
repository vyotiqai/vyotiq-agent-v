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

/**
 * A line that already ends a sentence or a clause. A clause end (the comma
 * the splitter cuts the first piece at) must not gain a full stop: "this
 * chat,." makes the voice drop its pitch mid-sentence.
 */
function endsSentence(line: string): boolean {
  return /[.!?:;,—–]["'”’)]*$/.test(line)
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

/**
 * What transcription models write for a breath, a click or room noise when
 * there were no words: fillers, and the stock lines Whisper-style models
 * invent. Never a turn (D-43). Real one-word answers ("yes", "stop") pass.
 */
const NOISE_TRANSCRIPTS = new Set(['you', 'uh', 'um', 'umm', 'hmm', 'mm', 'mhm', 'ah', 'oh', 'eh', 'huh', 'thanks for watching', 'thank you for watching'])

export function isNoiseTranscript(utterance: string): boolean {
  const norm = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return norm === '' || NOISE_TRANSCRIPTS.has(norm)
}

/**
 * Sound descriptions a listener writes in place of words: ElevenLabs Scribe
 * (also through OpenRouter) tags audio events by default, and 2026-10-14's
 * kept conversations show "[background noise]", "[clears throat]",
 * "[phone ringing]" and "[laughs]" each taken as a turn and answered. Square
 * brackets, music marks and asterisk actions always; parentheses only around
 * a short phrase with no numbers ("(laughs)"), so "version (2)" is kept.
 * Listeners don't write spoken asides in parentheses.
 */
const SOUND_TAG_RES = [/\[[^\]\n]{0,60}\]/g, /\*[^*\n]{1,40}\*/g, /\((?:[^()\n\d]{1,30})\)/g, /[♪♫♩♬]+/g]

/** What you said, without the listener's sound descriptions. Empty when there were no words. */
export function cleanTranscript(utterance: string): string {
  let text = utterance
  for (const re of SOUND_TAG_RES) text = text.replace(re, ' ')
  return text
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/^[\s,.;:!?-]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Languages written in Latin letters: a transcript in another script is the listener inventing (はい。 for a cough). */
const LATIN_LANGUAGES = new Set([
  'en', 'es', 'fr', 'de', 'it', 'pt', 'nl', 'sv', 'da', 'no', 'nb', 'fi', 'pl', 'cs', 'sk', 'ro', 'hu', 'tr', 'id', 'ms', 'vi', 'ca', 'hr', 'sl', 'et', 'lv', 'lt', 'tl'
])

/**
 * Letters, but none in the script of the language you set. Only for a
 * Latin-script language: a mixed or Latin transcript always passes.
 */
export function isOtherScript(utterance: string, language: string | undefined): boolean {
  const lang = language?.trim().toLowerCase().split(/[-_]/)[0]
  if (!lang || !LATIN_LANGUAGES.has(lang)) return false
  const letters = utterance.match(/\p{L}/gu)
  if (!letters || letters.length === 0) return false
  return !letters.some((ch) => /\p{Script=Latin}/u.test(ch))
}

/**
 * Words that only acknowledge ("okay", "thanks", "cool"). Said to nothing in
 * particular they need no answer, and answering each one ("Good — still
 * running.") kept a noisy room talking in circles. They are still a turn when
 * something was just asked: see the session.
 */
const BACKCHANNELS = new Set([
  'ok', 'okay', 'k', 'alright', 'all right', 'right', 'cool', 'nice', 'great', 'good', 'wow', 'yeah', 'yep', 'yup', 'yes', 'sure',
  'thanks', 'thank you', 'thank you so much', 'thanks a lot', 'got it', 'i see', 'mm hmm', 'mhm', 'uh huh', 'hm', 'hmm', 'aha', 'ah ok',
  'ok thanks', 'okay thanks', 'okay thank you', 'ok thank you', 'bye', 'bye bye', 'you', 'so', 'and', 'oh', 'oh okay', 'oh ok', 'perfect',
  'awesome', 'fine', 'sounds good', 'no problem'
])

export function isBackchannel(utterance: string): boolean {
  const norm = utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return BACKCHANNELS.has(norm)
}

/**
 * Talk that stops mid-thought: "Can you", "and then the", "so,". The voice
 * waits a moment before answering it, so the rest joins the same turn rather
 * than getting "Can you what?" back (2026-10-14's kept conversations).
 */
const DANGLING_END_RE =
  /(?:,|\b(?:and|or|but|because|then|to|the|an?|of|with|my|your|can you|could you|would you|will you|um|uh|if|i want to|let's)\s*[.…]?)$/i

export function soundsUnfinished(utterance: string): boolean {
  const text = utterance.trim()
  if (!text || /[?!]$/.test(text)) return false
  if (/(?:\.\.\.|…)$/.test(text)) return true
  return DANGLING_END_RE.test(text)
}

function normaliseUtterance(utterance: string): string {
  return utterance
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const YES = new Set(['yes', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay', 'go ahead', 'do it', 'allow', 'allow it', 'approve', 'approve it', 'yes please', 'go for it', 'fine', 'yes go ahead'])
const NO = new Set(['no', 'nope', 'nah', 'deny', 'deny it', "don't", 'do not', "don't do it", 'no thanks', 'skip', 'skip it', 'no don\'t'])

const ALWAYS = new Set([
  'always',
  'always allow',
  'always allow it',
  'allow always',
  'allow it always',
  'yes always',
  'always yes',
  "yes and don't ask again",
  "don't ask again",
  'yes always allow'
])

/**
 * A spoken answer to an approval (§7.5): `once` for yes, `deny` for no,
 * `always` for "always allow", null for anything else (which goes to the
 * agent as a message). Whole utterance only, like the stop phrases: "yes but
 * use the other file" is a message. Whether `always` may be given is the
 * session's call (`voiceMayAlwaysAllow`).
 */
export function approvalAnswer(utterance: string): 'once' | 'deny' | 'always' | null {
  const norm = normaliseUtterance(utterance)
  if (YES.has(norm)) return 'once'
  if (NO.has(norm)) return 'deny'
  if (ALWAYS.has(norm)) return 'always'
  return null
}
