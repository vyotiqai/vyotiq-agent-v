import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const workspaceLspStatus = vi.fn()
const workspaceLspRequest = vi.fn()

vi.mock('@main/workspace/lspService', () => ({
  workspaceLspStatus: (...args: unknown[]) => workspaceLspStatus(...args),
  workspaceLspRequest: (...args: unknown[]) => workspaceLspRequest(...args)
}))

import { executeTool } from '@main/agent/tools'
import { isApprovalExemptTool, stepToolBatchClass } from '@main/agent/tools/classify'
import { isToolGated } from '@main/agent/toolApproval'

describe('lsp tool', () => {
  const signal = new AbortController().signal

  afterEach(() => {
    workspaceLspStatus.mockReset()
    workspaceLspRequest.mockReset()
  })

  it('returns the Files-panel unavailable detail for an unsupported extension', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-'))
    writeFileSync(join(dir, 'notes.txt'), 'hello\n', 'utf8')
    workspaceLspStatus.mockResolvedValue({
      kind: 'unavailable',
      detail: 'No installed language server supports .txt.'
    })
    const result = await executeTool(
      'lsp',
      JSON.stringify({ path: 'notes.txt', action: 'diagnostics' }),
      dir,
      signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/No installed language server supports \.txt/)
    expect(workspaceLspRequest).not.toHaveBeenCalled()
  })

  it('formats diagnostics from the language server', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-'))
    writeFileSync(join(dir, 'a.ts'), 'const x: number = "no"\n', 'utf8')
    workspaceLspStatus.mockResolvedValue({
      kind: 'available',
      server: {
        id: 'typescript',
        label: 'TypeScript Language Server',
        command: 'typescript-language-server',
        source: 'path',
        capabilities: ['diagnostics']
      }
    })
    workspaceLspRequest.mockResolvedValue({
      kind: 'diagnostics',
      items: [{ line: 0, character: 6, message: 'Type string is not assignable', severity: 'error' }]
    })
    const result = await executeTool(
      'ReadLints',
      JSON.stringify({ path: 'a.ts' }),
      dir,
      signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/error 1:7 Type string is not assignable/)
  })

  it('Ask mode denies rename', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-'))
    writeFileSync(join(dir, 'a.ts'), 'const x = 1\n', 'utf8')
    const result = await executeTool(
      'lsp',
      JSON.stringify({ path: 'a.ts', action: 'rename', new_name: 'y', line: 0, character: 6 }),
      dir,
      signal,
      { agentMode: 'ask' }
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/does not allow lsp rename/)
    expect(workspaceLspRequest).not.toHaveBeenCalled()
  })

  it('treats hover as approval-exempt and rename as gated', () => {
    expect(isApprovalExemptTool('lsp', { action: 'hover' })).toBe(true)
    expect(isApprovalExemptTool('lsp', { action: 'rename' })).toBe(false)
    expect(isToolGated('lsp', 'mutating', new Set(), [], JSON.stringify({ action: 'rename' }))).toBe(
      true
    )
    expect(stepToolBatchClass('lsp', { action: 'diagnostics' })).toBe('read')
    expect(stepToolBatchClass('lsp', { action: 'rename' })).toBe('serial')
  })
})
