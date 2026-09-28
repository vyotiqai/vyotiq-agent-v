import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'
import {
  ASK_QUESTION_NO_ANSWER_GUIDANCE,
  ASK_QUESTION_SUPERSEDED_GUIDANCE
} from '@shared/utils/agentQuestionForm'
import { isInterruptedToolContent } from '../meta'

export type StatusMessageParsed = {
  chip: string
  message: string
  answers: string[]
}

/** Parse switch_mode / ask_question completed tool content. */
export function parseStatusMessageData(tool: UiToolRow): StatusMessageParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const content = (tool.content ?? '').trim()

  if (tool.name === 'switch_mode') {
    const mode = typeof args?.mode === 'string' ? args.mode : ''
    return {
      chip: mode || tool.summary?.trim() || 'mode',
      message: content || (mode ? `Mode: ${mode}` : ''),
      answers: []
    }
  }

  if (tool.name === 'ask_question') {
    // Pre-2026-09-28 results; the formatter no longer emits this.
    if (/^User provided no answer\.?$/i.test(content)) {
      return { chip: 'No answer', message: content, answers: [] }
    }
    const multi = content.match(/^User answered:[ \t]*\r?\n([\s\S]*)$/i)
    if (multi) {
      const answers = answerBullets(multi[1]!, singlePromptOf(args))
      return {
        chip: 'Answered',
        message: answers.length === 0 ? content : '',
        answers
      }
    }
    // Older single-question shape: `User answered: <value>` (value may span lines).
    const single = content.match(/^User answered:\s*([\s\S]+)$/i)
    if (single) {
      return { chip: 'Answered', message: '', answers: [single[1]!.trim()] }
    }
    // A run stopped while the question waited: the call never settled, so it
    // says how it was stopped — never that its arguments were wrong.
    if (isInterruptedToolContent(content)) {
      return { chip: content, message: content, answers: [] }
    }
    if (content === ASK_QUESTION_NO_ANSWER_GUIDANCE) {
      return { chip: 'Skipped', message: content, answers: [] }
    }
    if (content === ASK_QUESTION_SUPERSEDED_GUIDANCE) {
      return { chip: 'Replied instead', message: content, answers: [] }
    }
    // Pre-2026-09-28 skip text, from when a question could also time out.
    if (/^Question timed out or was dismissed/i.test(content)) {
      return { chip: 'No answer', message: content, answers: [] }
    }
    if (/^Question skipped \(autonomous mode\)/i.test(content)) {
      return { chip: 'Skipped', message: content, answers: [] }
    }
    if (
      tool.summary?.trim() === 'Invalid arguments' ||
      /Expected array, received string/i.test(content) ||
      /ask_question\.questions must be a JSON array/i.test(content) ||
      /question or questions is required/i.test(content) ||
      /questions must contain at least 1 item/i.test(content)
    ) {
      return {
        // Avoid duplicating the header "Failed" verb with another Failed chip.
        chip: 'Invalid arguments',
        message: content || tool.summary?.trim() || '',
        answers: []
      }
    }
    if (tool.status === 'fail') {
      // Any other failure says why in its own words; the chip only echoes the verb.
      return { chip: 'Failed', message: content || tool.summary?.trim() || '', answers: [] }
    }
    return {
      chip: 'Question',
      message: content || tool.summary?.trim() || '',
      answers: []
    }
  }

  return {
    chip: tool.summary?.trim() || tool.name,
    message: content,
    answers: []
  }
}

/** The prompt of a one-question form, whitespace-collapsed, or null. */
function singlePromptOf(args: Record<string, unknown> | null | undefined): string | null {
  if (!args) return null
  let prompt: unknown
  if (Array.isArray(args.questions)) {
    if (args.questions.length !== 1) return null
    const item = args.questions[0] as { prompt?: unknown; question?: unknown } | undefined
    prompt = typeof item?.prompt === 'string' ? item.prompt : item?.question
  } else {
    prompt = typeof args.question === 'string' ? args.question : args.prompt
  }
  return typeof prompt === 'string' && prompt.trim() ? prompt.replace(/\s+/g, ' ').trim() : null
}

/**
 * Bullets of a `formatQuestionAnswers` body — `- prompt: answer`, with indented
 * (or, in older results, unmarked) lines continuing the answer above. A
 * one-question form drops its own prompt, which the row already shows.
 */
function answerBullets(body: string, singlePrompt: string | null): string[] {
  const answers: string[] = []
  for (const line of body.split(/\r?\n/)) {
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      answers.push(bullet[1]!.trim())
    } else if (line.trim() && answers.length > 0) {
      answers[answers.length - 1] += `\n${line.trim()}`
    }
  }
  if (singlePrompt && answers.length === 1 && answers[0]!.startsWith(`${singlePrompt}: `)) {
    answers[0] = answers[0]!.slice(singlePrompt.length + 2)
  }
  return answers
}
