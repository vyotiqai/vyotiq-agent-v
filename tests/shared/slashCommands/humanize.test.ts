import { describe, expect, it } from 'vitest'
import { humanizeSlashToken } from '@shared/slashCommands'

describe('humanizeSlashToken', () => {
  it('turns snake_case into a readable sentence label', () => {
    expect(humanizeSlashToken('build_or_update_graph_tool')).toBe('Build or update graph tool')
  })

  it('turns kebab server ids into readable names', () => {
    expect(humanizeSlashToken('server-memory')).toBe('Server memory')
  })
})
