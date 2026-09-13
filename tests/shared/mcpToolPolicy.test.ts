import { describe, expect, it } from 'vitest'
import {
  formatMcpToolNameList,
  isMcpToolPermitted,
  parseMcpToolNameList
} from '@shared/utils/mcpToolPolicy'

describe('mcpToolPolicy', () => {
  it('allows all when no policy', () => {
    expect(isMcpToolPermitted('read_file', {})).toBe(true)
  })

  it('denies listed tools', () => {
    expect(isMcpToolPermitted('write_file', { deniedTools: ['write_file'] })).toBe(false)
    expect(isMcpToolPermitted('read_file', { deniedTools: ['write_file'] })).toBe(true)
  })

  it('restricts to allow list when non-empty', () => {
    expect(
      isMcpToolPermitted('read_file', { allowedTools: ['read_file', 'list_dir'] })
    ).toBe(true)
    expect(isMcpToolPermitted('write_file', { allowedTools: ['read_file'] })).toBe(false)
  })

  it('deny wins over allow', () => {
    expect(
      isMcpToolPermitted('read_file', {
        allowedTools: ['read_file'],
        deniedTools: ['read_file']
      })
    ).toBe(false)
  })

  it('parses and formats tool name lists', () => {
    expect(parseMcpToolNameList('a\nb, c')).toEqual(['a', 'b', 'c'])
    expect(parseMcpToolNameList('  \n  ')).toBeUndefined()
    expect(formatMcpToolNameList(['a', 'b'])).toBe('a\nb')
  })
})
