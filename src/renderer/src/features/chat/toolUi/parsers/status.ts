import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

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
    const answers: string[] = []
    if (/^User provided no answer\.?$/i.test(content)) {
      return { chip: 'No answer', message: content, answers: [] }
    }
    const multi = content.match(/^User answered:\s*\n([\s\S]*)$/i)
    if (multi) {
      for (const line of multi[1]!.split(/\r?\n/)) {
        const labeled = line.match(/^-\s+(.+?):\s+(.+)$/)
        if (labeled) {
          answers.push(`${labeled[1]!.trim()}: ${labeled[2]!.trim()}`)
          continue
        }
        const bullet = line.match(/^-\s+(.+)$/)
        if (bullet) answers.push(bullet[1]!.trim())
      }
      return {
        chip: 'Answered',
        message: answers.length === 0 ? content : '',
        answers
      }
    }
    const single = content.match(/^User answered:\s*(.+)$/i)
    if (single) {
      return { chip: 'Answered', message: '', answers: [single[1]!.trim()] }
    }
    if (/^Interrupted$/i.test(content)) {
      return { chip: 'Interrupted', message: content, answers: [] }
    }
    if (/^Question timed out or was dismissed/i.test(content)) {
      return { chip: 'Timed out', message: content, answers: [] }
    }
    if (/^Question skipped \(autonomous mode\)/i.test(content)) {
      return { chip: 'Skipped', message: content, answers: [] }
    }
    if (
      tool.status === 'fail' ||
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
