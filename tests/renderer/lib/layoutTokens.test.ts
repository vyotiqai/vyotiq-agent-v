import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  CHAT_COLUMN,
  CHAT_COLUMN_MAX,
  CHAT_GUTTER,
  COMPOSER_DOCK_COVER,
  COMPOSER_FLOAT_DOCK,
  MICRO_LABEL_CAPS
} from '@renderer/lib/utils/layout'

describe('layout typography and spacing tokens', () => {
  it('exports the chat gutter', () => {
    expect(CHAT_GUTTER).toBe('px-4 sm:px-5')
  })

  it('exports column max-width tokens', () => {
    expect(CHAT_COLUMN).toContain(CHAT_COLUMN_MAX)
    expect(CHAT_COLUMN_MAX).toBe('max-w-[840px]')
  })

  it('exports micro label tokens', () => {
    expect(MICRO_LABEL_CAPS).toContain('text-2xs')
    expect(MICRO_LABEL_CAPS).toContain('tracking-[var(--vy-tracking-caps)]')
  })

  it('fades the composer cover upward across its pt-4', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    const cover = /@utility vy-composer-dock-cover \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(cover).toContain('linear-gradient(to top, var(--vy-bg) calc(100% - 1rem), transparent)')
    expect(COMPOSER_DOCK_COVER).toBe('vy-composer-dock-cover pt-4 pb-2')
    // Flush with the stage bottom: the gap under the shell is covered padding.
    expect(COMPOSER_FLOAT_DOCK).toContain('bottom-0')
  })

  it('spills the composer cover 2px past the column so edge glyphs never peek out', () => {
    const css = readFileSync(join(__dirname, '../../../src/renderer/src/styles.css'), 'utf8')
    const cover = /@utility vy-composer-dock-cover \{([^}]*)\}/.exec(css)?.[1] ?? ''
    expect(cover).toContain('box-shadow: -2px 0 var(--vy-bg), 2px 0 var(--vy-bg)')
  })
})
