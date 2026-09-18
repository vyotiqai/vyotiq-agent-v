/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { useState } from 'react'
import type { LocalSkillItem } from '@shared/ipc'
import { MarketplaceSkillsPane } from '@renderer/features/marketplace/MarketplaceSkillsPane'
import type { MarketplaceController } from '@renderer/features/marketplace/useMarketplaceController'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const shipSkill: LocalSkillItem = {
  id: 'skill:local:project:ship',
  name: 'ship',
  description: 'Ship it.',
  source: 'project',
  origin: 'vyotiq',
  skillPath: 'C:/ws/.vyotiq/skills/ship/SKILL.md',
  relativePath: '.vyotiq/skills/ship/SKILL.md'
}

function stubSkillsApi(): void {
  ;(window as unknown as { vyotiq: unknown }).vyotiq = {
    skillsReadLocal: vi.fn(async () => ({
      ok: true as const,
      data: {
        skillPath: shipSkill.skillPath,
        content: '',
        name: shipSkill.name,
        description: shipSkill.description,
        body: '# Ship\n'
      }
    }))
  }
}

/**
 * Mirrors MarketplaceView: the focus prop is cleared as soon as the pane
 * reports it consumed, which is what used to cancel the pending scroll.
 */
function Harness({ skills, focus }: { skills: LocalSkillItem[]; focus: string | null }) {
  const [focusPath, setFocusPath] = useState<string | null>(focus)
  const controller = {
    localSkills: skills,
    formLocked: false,
    setFeedback: vi.fn()
  } as unknown as MarketplaceController
  return (
    <MarketplaceSkillsPane
      controller={controller}
      activeWorkspacePath="C:/ws"
      focusSkillPath={focusPath}
      onFocusSkillConsumed={() => setFocusPath(null)}
    />
  )
}

describe('MarketplaceSkillsPane focus handoff', () => {
  it('scrolls the focused skill row into view and opens its editor', async () => {
    const scrollIntoView = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      scrollIntoView
    stubSkillsApi()

    render(<Harness skills={[shipSkill]} focus={shipSkill.skillPath} />)

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled()
    })
    expect(document.activeElement?.getAttribute('data-skill-path')).toBe(shipSkill.skillPath)
    await waitFor(() => {
      expect(screen.getByLabelText('Skill name')).toBeTruthy()
    })
  })

  it('still scrolls when the created skill only reaches the list after a reload', async () => {
    const scrollIntoView = vi.fn()
    ;(Element.prototype as unknown as { scrollIntoView: () => void }).scrollIntoView =
      scrollIntoView
    stubSkillsApi()

    // First render has no rows yet — the skills-changed reload has not landed.
    const { rerender } = render(<Harness skills={[]} focus={shipSkill.skillPath} />)
    expect(scrollIntoView).not.toHaveBeenCalled()

    rerender(<Harness skills={[shipSkill]} focus={shipSkill.skillPath} />)
    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalled()
    })
  })
})
