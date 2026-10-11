/**
 * The agent's own questions (`ask_question`) in a live session
 * (docs/voice-mode.md §7.5, B9): reading one out, and turning a spoken reply
 * into the answer the card would have sent. Pure functions only.
 *
 * A reply that doesn't clearly answer is not forced into one: it goes to the
 * agent as an ordinary message, which closes the card and is read as the
 * answer anyway (ASK_QUESTION_SUPERSEDED_GUIDANCE). So a miss here costs
 * nothing but precision.
 */
import type { AgentQuestionItem, AgentQuestionRequest } from '../../shared/ipc'
import { approvalAnswer, toSpeakable } from './speechText'

/** Read out the choices when there are this few; more go on screen only. */
export const MAX_SPOKEN_OPTIONS = 4
const MAX_PROMPT_CHARS = 220
/**
 * A free-form pick longer than this is probably more than a pick ("none of
 * those, and also…"), so it goes as a message, where nothing is cut off.
 */
export const MAX_CUSTOM_PICK_WORDS = 8

function norm(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function spokenPrompt(prompt: string): string {
  let text = toSpeakable(prompt)
  // toSpeakable closes every line with a period; a bare prompt is a question.
  if (!/[.!?…]["'”’)]*$/.test(prompt.trim())) text = text.replace(/\.$/, '')
  if (text.length <= MAX_PROMPT_CHARS) return text
  return `${text.slice(0, MAX_PROMPT_CHARS).replace(/\s+\S*$/, '')}…`
}

function orList(items: readonly string[], joiner: 'or' | 'and'): string {
  if (items.length <= 1) return items[0] ?? ''
  return `${items.slice(0, -1).join(', ')} ${joiner} ${items[items.length - 1]}`
}

/** Whether a spoken reply can answer this form directly (one question, not a pile of them). */
export function answerableByVoice(request: Pick<AgentQuestionRequest, 'questions'>): boolean {
  return request.questions.length === 1
}

/** What to say when the agent asks (§7.5): the question, and its choices when there are few. */
export function describeQuestion(request: Pick<AgentQuestionRequest, 'questions'>): string {
  const [first] = request.questions
  if (!first) return 'It has a question for you. It’s on screen.'
  if (request.questions.length > 1) {
    return `It has ${request.questions.length} questions for you. They’re on screen, or just tell me what you want.`
  }
  const prompt = spokenPrompt(first.prompt)
  const ask = /[?.!…]$/.test(prompt) ? prompt : `${prompt}?`
  if (first.type === 'boolean') return `${ask} Yes or no?`
  const options = (first.options ?? []).map((o) => toSpeakable(o).replace(/[.]+$/, ''))
  if ((first.type === 'single' || first.type === 'multi') && options.length > 0) {
    if (options.length > MAX_SPOKEN_OPTIONS) return `${ask} The options are on screen.`
    return `${ask} ${orList(options, first.type === 'multi' ? 'and' : 'or')}.`
  }
  return ask
}

const ORDINALS: Record<string, number> = {
  first: 0, one: 0, '1': 0, '1st': 0,
  second: 1, two: 1, '2': 1, '2nd': 1,
  third: 2, three: 2, '3': 2, '3rd': 2,
  fourth: 3, four: 3, '4': 3, '4th': 3,
  fifth: 4, five: 4, '5': 4, '5th': 4
}

/** "the second one", "option 3", "number two", "the last one" → an index, or null. */
function ordinalPick(utterance: string, count: number): number | null {
  const m =
    /^(?:the |option |number |choice )?(first|second|third|fourth|fifth|last|one|two|three|four|five|[1-5](?:st|nd|rd|th)?)(?: one| option)?(?: please)?$/.exec(utterance)
  if (!m) return null
  const word = m[1]!
  const index = word === 'last' ? count - 1 : ORDINALS[word]
  return index !== undefined && index >= 0 && index < count ? index : null
}

/** The options named in the reply, in order. */
function optionsNamed(utterance: string, options: readonly string[]): string[] {
  const padded = ` ${utterance} `
  return options.filter((o) => {
    const n = norm(o)
    return n.length > 0 && padded.includes(` ${n} `)
  })
}

/**
 * A spoken reply as the card's answer values for one question, or null when
 * it doesn't clearly answer (it then goes to the agent as a message).
 */
export function questionAnswer(item: AgentQuestionItem, utterance: string): string[] | null {
  const said = utterance.trim()
  const n = norm(said)
  if (!n) return null
  if (item.type === 'boolean') {
    const yesNo = approvalAnswer(said)
    return yesNo === 'once' ? ['Yes'] : yesNo === 'deny' ? ['No'] : null
  }
  if (item.type === 'text') return [said]

  const options = item.options ?? []
  const exact = options.find((o) => norm(o) === n)
  if (exact) return [exact]
  const picked = ordinalPick(n, options.length)
  if (picked !== null) return [options[picked]!]
  const named = optionsNamed(n, options)
  if (item.type === 'multi' && named.length > 0) return named
  if (item.type === 'single' && named.length === 1) return named
  // Something else entirely: theirs to say, if the question allows it.
  if (item.allowCustom && named.length === 0 && n.split(' ').length <= MAX_CUSTOM_PICK_WORDS) return [said]
  return null
}
