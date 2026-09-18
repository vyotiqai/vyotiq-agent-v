/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { Settings } from '@shared/ipc'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { MarketplaceRulesPane } from '@renderer/features/marketplace/MarketplaceRulesPane'
import type { MarketplaceController } from '@renderer/features/marketplace/useMarketplaceController'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const RULE_PATH = '.vyotiq/rules/release-notes.md'

const RULE_CONTENT = [
  '---',
  'alwaysApply: true',
  'description: Release notes',
  '---',
  '',
  '# Release notes',
  ''
].join('\n')

const settings: Settings = { ...DEFAULT_SETTINGS, userRules: [] }

function stubRulesApi(rules: Array<{ path: string; alwaysApply: boolean }>): void {
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    workspaceListRules: vi.fn(async () => ({ ok: true as const, data: { rules } })),
    onSkillsChanged: vi.fn(() => () => {}),
    workspaceFileRead: vi.fn(async () => ({
      ok: true as const,
      data: {
        kind: 'text' as const,
        content: RULE_CONTENT,
        encoding: 'utf8' as const,
        eol: 'lf' as const,
        bom: false,
        version: { size: RULE_CONTENT.length, mtimeMs: 1, sha256: 'abc' }
      }
    }))
  }
}

/**
 * Mirrors MarketplaceView: the focus prop is cleared as soon as the pane
 * reports it consumed, which is what used to cancel the pending scroll.
 */
function Harness({ focus }: { focus: string | null }) {
  const [focusPath, setFocusPath] = useState<string | null>(focus)
  const controller = {
    formLocked: false,
    setFeedback: vi.fn()
  } as unknown as MarketplaceController
  return (
    <MarketplaceRulesPane
      controller={controller}
      settings={settings}
      onUpdate={async () => ({ ok: true as const })}
      activeWorkspacePath="C:/ws"
      focusRulePath={focusPath}
      onFocusRuleConsumed={() => setFocusPath(null)}
    />
  )
}

describe('MarketplaceRulesPane focus handoff', () => {
  it('scrolls the focused rule row into view once the list has loaded', async () => {
    const scrollIntoView = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      scrollIntoView
    stubRulesApi([{ path: RULE_PATH, alwaysApply: true }])

    render(<Harness focus={RULE_PATH} />)

    // The rule list arrives asynchronously, so the row does not exist on the
    // first pass — the scroll must still happen when it lands.
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled()
    })
    expect(document.activeElement?.getAttribute('data-rule-path')).toBe(RULE_PATH)
  })
})
