import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHAT_COLUMN,
  CHAT_COLUMN_MAX,
  CHAT_GUTTER,
  CHAT_STAGE_TOP_INSET,
  CHAT_STAGE_TOP_SPACER,
  COMPOSER_DOCK_COVER,
  COMPOSER_FLOAT_DOCK,
  MICRO_LABEL,
  MICRO_LABEL_CAPS,
  TRANSCRIPT_ROW_GAP,
  TRANSCRIPT_TURN_GAP,
  TRANSCRIPT_WORK_ROW_GAP,
  TURN_PROMPT_STACK,
  TURN_PROMPT_STACK_PINNED,
  USER_PROMPT_CLAMP_LINES,
  USER_PROMPT_INSET,
  USER_PROMPT_SURFACE
} from '@renderer/lib/utils/layout'

describe('layout typography and spacing tokens', () => {
  it('exports the chat gutter', () => {
    expect(CHAT_GUTTER).toBe('px-4 sm:px-5')
  })

  it('exports column max-width tokens', () => {
    expect(CHAT_COLUMN).toContain(CHAT_COLUMN_MAX)
    expect(CHAT_COLUMN_MAX).toBe('max-w-[840px]')
  })

  it('exports transcript rhythm gaps', () => {
    expect(TRANSCRIPT_ROW_GAP).toBe('pb-2.5')
    expect(TRANSCRIPT_WORK_ROW_GAP).toBe('pb-4')
    expect(TRANSCRIPT_TURN_GAP).toBe('pt-8')
  })

  it('exports user prompt surface typography', () => {
    // The bordered prompt still steps up from the 13px body scale to the
    // heading scale.
    expect(USER_PROMPT_SURFACE).toContain('text-heading')
    expect(USER_PROMPT_SURFACE).not.toContain('text-sm')
    expect(USER_PROMPT_SURFACE).toContain('leading-normal')
    expect(USER_PROMPT_SURFACE).toContain('text-fg-strong')
    expect(USER_PROMPT_SURFACE).toContain('tracking-[var(--vy-tracking-tight)]')
    // A stable, unfilled border defines the user's prompt bubble without a
    // shadow.
    expect(USER_PROMPT_SURFACE).toContain('w-full')
    expect(USER_PROMPT_SURFACE).toContain('border')
    expect(USER_PROMPT_SURFACE).toContain('border-border')
    expect(USER_PROMPT_SURFACE).not.toContain('bg-')
    expect(USER_PROMPT_SURFACE).not.toContain('shadow-')
    expect(USER_PROMPT_SURFACE).toContain('px-3')
  })

  it('exports micro label tokens', () => {
    expect(MICRO_LABEL).toContain('text-caption')
    expect(MICRO_LABEL_CAPS).toContain('text-2xs')
    expect(MICRO_LABEL_CAPS).toContain('tracking-[var(--vy-tracking-caps)]')
  })

  it('keeps the pinned prompt cover compact, fading only across its bottom padding', () => {
    // The cover fades over its last 1rem, which must stay the stack's pb-4:
    // any longer and rows would show through behind the tasks band.
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    const cover = /@utility vy-turn-prompt-cover \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(cover).toContain('var(--vy-bg) calc(100% - 1rem), transparent')
    expect(TURN_PROMPT_STACK).toBe('pt-2.5 pb-4')
    expect(TURN_PROMPT_STACK_PINNED).toContain('vy-turn-prompt-cover')
    expect(TURN_PROMPT_STACK_PINNED).toContain('top-0')
    // The cover owns its background; no chrome rides on the stack classes.
    for (const token of [TURN_PROMPT_STACK, TURN_PROMPT_STACK_PINNED]) {
      expect(token).not.toContain('border')
      expect(token).not.toContain('shadow')
      expect(token).not.toContain('bg-')
    }
  })

  it('mirrors the prompt cover under the composer, fading upward across its pt-4', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    const cover = /@utility vy-composer-dock-cover \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(cover).toContain('linear-gradient(to top, var(--vy-bg) calc(100% - 1rem), transparent)')
    expect(COMPOSER_DOCK_COVER).toBe('vy-composer-dock-cover pt-4 pb-2')
    // Flush with the stage bottom: the gap under the shell is covered padding.
    expect(COMPOSER_FLOAT_DOCK).toContain('bottom-0')
  })

  it('spills both covers 2px past the column so edge glyphs never peek out', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    for (const name of ['vy-turn-prompt-cover', 'vy-composer-dock-cover']) {
      const cover = new RegExp(`@utility ${name} \\{([^}]*)\\}`).exec(css)?.[1] ?? ''
      expect(cover).toContain('box-shadow: -2px 0 var(--vy-bg), 2px 0 var(--vy-bg)')
    }
  })

  it('insets the row under the prompt by the bubble border and padding', () => {
    // The tasks band starts on the prompt text's edge only while both share
    // one box model: a 1px border (transparent here) plus px-3.
    expect(USER_PROMPT_SURFACE).toMatch(/(^| )border( |$)/)
    expect(USER_PROMPT_SURFACE).toContain('px-3')
    expect(USER_PROMPT_INSET).toBe('border-x border-transparent px-3')
  })

  it('folds the user prompt to two lines', () => {
    expect(USER_PROMPT_CLAMP_LINES).toBe(2)
  })

  it('pairs the stage top inset with a scrolled spacer of the same height', () => {
    // Chromium insets a sticky child's `top: 0` by the scroller's own
    // padding-top, so the transcript can only carry its top inset as a scrolled
    // spacer — otherwise rows bleed through the strip above the pinned prompt.
    expect(CHAT_STAGE_TOP_INSET).toBe('pt-4')
    expect(CHAT_STAGE_TOP_SPACER).toBe('h-4')
  })
})
