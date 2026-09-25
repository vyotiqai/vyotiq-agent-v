import { describe, expect, it } from 'vitest'
import { allowedEntryLabel } from '@renderer/features/settings/sections/AgentSection'

describe('allowedEntryLabel', () => {
  it('reads a terminal allow as the command it lets through', () => {
    expect(allowedEntryLabel('terminal:pnpm vitest')).toEqual({ label: 'pnpm vitest', command: true })
  })

  it('shows an agent-built tool by name, without the content hash it is pinned to', () => {
    expect(allowedEntryLabel('my-tool@0123456789abcdef')).toEqual({ label: 'my-tool', command: false })
  })

  it('shows any other tool by its name — a whole-tool terminal allow granted before included', () => {
    expect(allowedEntryLabel('edit')).toEqual({ label: 'edit', command: false })
    expect(allowedEntryLabel('terminal')).toEqual({ label: 'terminal', command: false })
  })
})
