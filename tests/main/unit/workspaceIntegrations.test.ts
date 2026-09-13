import { mkdtempSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { describe, expect, it } from 'vitest'
import { formatWorkspaceFile, workspaceFormatterStatus } from '@main/workspace/formatter'
import { workspaceLspStatus } from '@main/workspace/lspService'

describe('workspace integrations', () => {
  it('keeps formatter discovery unavailable for unsupported files', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-formatter-'))
    try {
      await expect(workspaceFormatterStatus(workspacePath, 'image.bin')).resolves.toMatchObject({
        kind: 'unavailable'
      })
      await expect(formatWorkspaceFile(workspacePath, 'image.bin', 'binary')).resolves.toMatchObject({
        kind: 'unavailable'
      })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })

  it('does not claim an LSP for an unsupported language', async () => {
    const workspacePath = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-'))
    try {
      await expect(workspaceLspStatus(workspacePath, 'file.unknown')).resolves.toMatchObject({
        kind: 'unavailable'
      })
    } finally {
      rmSync(workspacePath, { recursive: true, force: true })
    }
  })
})
