import { describe, expect, it, vi } from 'vitest'
import { join } from 'path'

// Point the real loader at the real repo resources/ dir (dev-mode path shape).
const repoRoot = process.cwd()
vi.mock('electron', () => ({
  app: {
    getAppPath: () => repoRoot,
    getPath: () => join(repoRoot, 'node_modules/.tmp-harness-probe'),
    isPackaged: false
  }
}))

import { loadHarness } from '@main/agent/harness'
import { splitHarnessSections } from '@main/agent/harnessSections'

describe('canonical harness delivers tool-selection guidance', () => {
  it('bundled tool_policy carries deliberate tool choice, prerequisites, and blocking-tool budget rules', () => {
    const loaded = loadHarness(repoRoot)
    expect(loaded).toContain(
      'Choose tools deliberately instead of defaulting to the first familiar one'
    )
    expect(loaded).toContain('create_goal before update_goal')
    expect(loaded).toContain('Budget blocking tools')
    const toolPolicy = splitHarnessSections(loaded).find((c) => c.name === 'tool_policy')
    expect(toolPolicy).toBeTruthy()
    expect(toolPolicy!.text).toContain('Choose tools deliberately')
    expect(toolPolicy!.text).toContain('Respect tool prerequisites')
    expect(toolPolicy!.text).toContain('Budget blocking tools')
  })

  it('tool_policy directs multi-file batches to per-file edit/str_replace calls', () => {
    const loaded = loadHarness(repoRoot)
    const toolPolicy = splitHarnessSections(loaded).find((c) => c.name === 'tool_policy')
    expect(toolPolicy).toBeTruthy()
    expect(toolPolicy!.text).toContain(
      'When several workspace files change together in one step, use a separate edit or str_replace call per file'
    )
    expect(toolPolicy!.text).not.toContain('multi_edit')
    expect(toolPolicy!.text).toContain('either contents or diff, never both')
  })
})
