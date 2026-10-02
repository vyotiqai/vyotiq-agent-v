import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/agent/tools', () => ({
  executeTool: vi.fn(),
  AGENT_TOOLS: []
}))

import { SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS } from '@main/agent/executeStepTools'
import { formatAttachedInstructions } from '@main/agent/context/nestedInstructions'
import { stripModelNotes } from '@shared/utils/modelNotes'

/**
 * The record drops the notes the loop appends to a tool result for the model.
 * These build each note with main's own code, so a reworded note fails here
 * instead of showing up in the record again.
 */
describe('stripModelNotes against the notes main writes', () => {
  it('drops the diagnostics nudge after an edit', () => {
    const content = `Deleted tests/a.test.ts\n\n${SOFT_WARN_MUTATION_WITHOUT_DIAGNOSTICS}`
    expect(stripModelNotes(content)).toBe('Deleted tests/a.test.ts')
  })

  it('drops an edit-without-reading warning and a re-read note', () => {
    const content =
      'Replaced 1 occurrence in src/a.ts (line 3)\n\n[Soft warning: edited existing file(s) without a prior read/grep/glob/codebase_search inspect: src/a.ts]' +
      '\n\n[Note: src/a.ts was already read 2 steps ago and its contents are in your context. Re-read only if you expect it changed.]'
    expect(stripModelNotes(content)).toBe('Replaced 1 occurrence in src/a.ts (line 3)')
  })

  it('drops attached workspace instructions', () => {
    const block = formatAttachedInstructions([{ source: 'src/AGENTS.md', appliesTo: 'src/', content: 'Use tabs.\n\nNever log.' }])
    expect(stripModelNotes(`const a = 1\n\n${block}`)).toBe('const a = 1')
  })

  it('keeps output that merely mentions a note', () => {
    const content = 'grep hits:\nsrc/x.ts:4: "[Soft warning: …]" is appended'
    expect(stripModelNotes(content)).toBe(content)
  })
})
