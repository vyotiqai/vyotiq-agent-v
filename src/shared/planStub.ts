/** Shared Plan-mode `plan.md` stub and chrome detection. */

export const PLAN_STUB_HINT =
  'Write the plan with create_plan. Stay on plan.md — do not edit product source.'

/** Substring used to detect an unfilled Plan-mode stub. */
export const PLAN_STUB_MARKER = 'Draft the plan here.'

/**
 * Canonical plan skeleton seeded into plan.md. Each prompt is an italic
 * placeholder that `isPlanSectionPromptLine` strips once chrome detection
 * sees the draft (keep the normalized strings in LEGACY_PROMPTS in sync).
 */
export const PLAN_SECTIONS = [
  { heading: 'Goal', prompt: 'What result do you want?' },
  { heading: 'Scope', prompt: 'What is included and excluded?' },
  {
    heading: 'Steps',
    prompt: 'Small, understandable phases — each names affected paths and how it is verified.'
  },
  { heading: 'Done when', prompt: 'How the finished work will be checked?' },
  { heading: 'Risks', prompt: 'Anything that could affect the outcome?' }
] as const

const LEGACY_HEADINGS = [
  'Goal',
  'Success criteria',
  'Scope',
  'Open questions',
  'Approach',
  'Ordered steps',
  'Verification',
  'Risks or trade-offs',
  'Risks',
  'Steps',
  'Done when'
] as const

const LEGACY_PROMPTS = new Set([
  'what result do you want',
  'how will we know it worked',
  'what is included and excluded',
  'what needs your decision',
  'what direction will be taken and why',
  'small, understandable phases',
  'small, understandable phases — each names affected paths and how it is verified',
  'how the finished work will be checked',
  'anything that could affect the outcome'
])

const STUB_HEADING_KEYS = new Set(LEGACY_HEADINGS.map((heading) => planSectionKey(heading)))

export const DEFAULT_PLAN_STUB = [
  '# Plan',
  '',
  `_${PLAN_STUB_HINT}_`,
  '',
  ...PLAN_SECTIONS.flatMap(({ heading, prompt }) => [`## ${heading}`, '', `_${prompt}_`, ''])
].join('\n')

function unwrapEmphasis(line: string): string {
  return line
    .trim()
    .replace(/^_{1,2}/, '')
    .replace(/_{1,2}$/, '')
    .replace(/^\*{1,2}/, '')
    .replace(/\*{1,2}$/, '')
    .trim()
}

function normalizePromptText(text: string): string {
  return unwrapEmphasis(text)
    .toLowerCase()
    .replace(/[.?!]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

export function isPlanTitleLine(line: string): boolean {
  return /^#\s*Plan\s*$/i.test(line.trim())
}

export function isPlanStubHintLine(line: string): boolean {
  const text = unwrapEmphasis(line)
  if (!text) return false
  if (/^draft the plan here\b/i.test(text)) return true
  if (/^write the plan with create_plan\b/i.test(text)) return true
  return false
}

export function isPlanHeadingLine(line: string): boolean {
  return /^#{1,6}(\s|$)/.test(line.trim())
}

export function isPlanSectionPromptLine(line: string): boolean {
  const normalized = normalizePromptText(line)
  return normalized.length > 0 && LEGACY_PROMPTS.has(normalized)
}

/** Heading key for chrome detection: `Goal — …` → `goal`. */
export function planSectionKey(headingText: string): string {
  return headingText
    .replace(/\s*[—–]\s+.*$/, '')
    .replace(/\s+-\s+.*$/, '')
    .trim()
    .toLowerCase()
}

export function isPlanStubChromeLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed) return true
  if (isPlanTitleLine(trimmed)) return true
  if (isPlanStubHintLine(trimmed)) return true
  const heading = trimmed.match(/^#{1,6}\s+(.+?)\s*$/)
  if (heading) return STUB_HEADING_KEYS.has(planSectionKey(heading[1]!))
  if (isPlanSectionPromptLine(trimmed)) return true
  if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(trimmed)) return true
  if (/^`{3,}/.test(trimmed)) return true
  return false
}

/** Body remaining after stub headings, hints, and leftover section prompts. */
export function stripPlanStubChrome(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((line) => !isPlanStubChromeLine(line))
    .join('\n')
    .trim()
}