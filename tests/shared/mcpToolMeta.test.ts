import { describe, expect, it } from 'vitest'
import {
  humanizeSnakeCase,
  mcpDoneLabel,
  mcpRunningLabel,
  mcpToolKind
} from '@shared/utils/mcpToolMeta'

describe('mcpToolMeta', () => {
  it('classifies MCP tools by name', () => {
    expect(mcpToolKind('read_text_file')).toBe('file')
    expect(mcpToolKind('list_allowed_directories')).toBe('browse')
    expect(mcpToolKind('directory_tree')).toBe('browse')
    expect(mcpToolKind('grep_search')).toBe('search')
  })

  it('humanizes snake_case names', () => {
    expect(humanizeSnakeCase('directory_tree')).toBe('Directory Tree')
  })

  it('labels MCP tools with readable verbs', () => {
    expect(mcpRunningLabel('read_text_file')).toBe('Reading file')
    expect(mcpDoneLabel('read_text_file')).toBe('Read file')
    expect(mcpDoneLabel('list_allowed_directories')).toBe('Listed directories')
    expect(mcpRunningLabel('directory_tree')).toBe('Browsing directories')
  })
})
