import { describe, expect, it } from 'vitest'
import {
  CHAT_COLUMN,
  CHAT_COLUMN_MAX,
  CHAT_GUTTER,
  COMPOSER_FLOAT_FADE,
  CHAT_STAGE_INSET,
  MICRO_LABEL,
  MICRO_LABEL_CAPS,
  SETTINGS_COLUMN,
  SETTINGS_COLUMN_MAX,
  SETTINGS_GUTTER,
  SIDEBAR_ROW_ACTIVE,
  SIDEBAR_ROW_FOCUSED,
  SIDEBAR_ROW_OPEN,
  SIDEBAR_SEARCH_ROW,
  SIDEBAR_SECTION_LABEL,
  SIDEBAR_TOOLBAR_ROW,
  TRANSCRIPT_ROW_GAP,
  TRANSCRIPT_TURN_GAP,
  TRANSCRIPT_WORK_ROW_GAP,
  USER_PROMPT_SURFACE
} from '@renderer/lib/utils/layout'

describe('layout typography and spacing tokens', () => {
  it('aligns settings gutter with chat gutter', () => {
    expect(SETTINGS_GUTTER).toBe(CHAT_GUTTER)
    expect(CHAT_GUTTER).toBe('px-4 sm:px-5')
  })

  it('exports column max-width tokens', () => {
    expect(CHAT_COLUMN).toContain(CHAT_COLUMN_MAX)
    expect(CHAT_COLUMN_MAX).toBe('max-w-[840px]')
    expect(SETTINGS_COLUMN).toContain(SETTINGS_COLUMN_MAX)
    expect(SETTINGS_COLUMN).not.toContain('mx-auto')
    expect(SETTINGS_COLUMN_MAX).toBe('max-w-[680px]')
  })

  it('exports transcript rhythm gaps', () => {
    expect(TRANSCRIPT_ROW_GAP).toBe('pb-2.5')
    expect(TRANSCRIPT_WORK_ROW_GAP).toBe('pb-4')
    expect(TRANSCRIPT_TURN_GAP).toBe('pt-8')
  })

  it('exports user prompt surface typography', () => {
    expect(USER_PROMPT_SURFACE).toContain('text-sm')
    expect(USER_PROMPT_SURFACE).toContain('leading-relaxed')
    expect(USER_PROMPT_SURFACE).toContain('tracking-[var(--vy-tracking-body)]')
    expect(USER_PROMPT_SURFACE).toContain('vy-chrome')
  })

  it('fades the composer dock into the stage background, not the composer surface', () => {
    expect(COMPOSER_FLOAT_FADE).toContain('from-[var(--vy-bg)]')
    expect(COMPOSER_FLOAT_FADE).not.toContain('--vy-chrome-surface')
  })

  it('exports micro label tokens', () => {
    expect(MICRO_LABEL).toContain('text-caption')
    expect(MICRO_LABEL_CAPS).toContain('text-2xs')
    expect(MICRO_LABEL_CAPS).toContain('tracking-[var(--vy-tracking-caps)]')
    expect(SIDEBAR_SECTION_LABEL).toContain(MICRO_LABEL)
  })

  it('exports chat stage inset clearing the side rail', () => {
    expect(CHAT_STAGE_INSET).toContain('pr-10')
    expect(CHAT_STAGE_INSET).toContain('pl-4')
  })

  it('documents sidebar list active accent', () => {
    expect(SIDEBAR_ROW_ACTIVE).toContain('border-l-fg-strong')
    expect(SIDEBAR_ROW_OPEN).toContain('bg-surface/20')
    expect(SIDEBAR_ROW_FOCUSED).toContain('bg-surface/45')
    expect(SIDEBAR_ROW_FOCUSED).toContain('font-semibold')
  })

  it('exports sidebar toolbar row aligned with main title bar', () => {
    expect(SIDEBAR_TOOLBAR_ROW).toContain('h-9')
    expect(SIDEBAR_TOOLBAR_ROW).toContain('items-center')
    expect(SIDEBAR_SEARCH_ROW).toContain('pb-2')
  })
})
