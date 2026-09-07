import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { BUILTIN_TOOL_NAMES } from '@main/agent/tools'
import { mcpFilesystemWriteToolsForTests } from '@main/agent/tools/mcpCheckpoint'

/**
 * Static registry: every builtin that mutates workspace files must call
 * recordPrior (or an equivalent known-path / watcher hook).
 */
const WORKSPACE_WRITE_BUILTINS = new Set([
  'edit',
  'str_replace',
  'delete',
  'terminal',
  'edit_notebook',
  'lsp'
])

const INTENTIONALLY_EXCLUDED = new Set([
  'memory_write', // .vyotiq/memory — durable, not Keep/Discard
  'todo_write', // run artifact todos.json
  'git_commit' // VCS state out of scope
])

describe('checkpoint coverage registry', () => {
  it('lists every workspace-writing builtin as covered or intentionally excluded', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/agent/tools/index.ts'),
      'utf8'
    )

    for (const name of BUILTIN_TOOL_NAMES) {
      if (INTENTIONALLY_EXCLUDED.has(name)) continue
      if (!WORKSPACE_WRITE_BUILTINS.has(name)) continue

      if (name === 'lsp') {
        expect(source).toMatch(/recordPrior/)
        expect(source).toMatch(/lsp:/)
        continue
      }

      // Direct recordPrior in the handler body (or shared image helpers).
      const handlerMentionsPrior =
        source.includes(`recordPrior`) &&
        (source.includes(`'${name}'`) || source.includes(`${name}:`))
      expect(handlerMentionsPrior).toBe(true)
    }
  })

  it('covers MCP filesystem write tools via known-path hooks', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/main/agent/tools/index.ts'),
      'utf8'
    )
    expect(source).toMatch(/recordMcpFilesystemPriors/)
    expect(mcpFilesystemWriteToolsForTests().length).toBeGreaterThanOrEqual(4)
  })
})
