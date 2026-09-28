import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import type { ChatMessage } from '@shared/ipc'

vi.mock('@main/app/window', () => ({ getMainWindow: () => null }))
vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ ...DEFAULT_SETTINGS }) }))
const { invokeMcpTool } = vi.hoisted(() => ({
  invokeMcpTool: vi.fn(async () => ({ ok: true, summary: 'write_file', content: 'written' }))
}))
vi.mock('@main/agent/mcp', async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getMcpToolDefinition: () => ({ name: 'mcp__filesystem__write_file', description: '', parameters: {} }),
  invokeMcpTool
}))

import { executeStepToolCalls } from '@main/agent/executeStepTools'
import { beginWriteCheckpoint, discardWriteCheckpoint } from '@main/agent/checkpoints'

/**
 * A filesystem MCP server may be allowed directories outside the workspace.
 * Its write there has no workspace prior — the checkpoint skips it instead of
 * throwing "Path escapes workspace" out of the tool and failing the whole run.
 */
describe('MCP filesystem write outside the workspace', () => {
  it('runs the tool and returns one result instead of failing the step', async () => {
    const ws = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-out-ws-'))
    const runDir = mkdtempSync(join(tmpdir(), 'vyotiq-mcp-out-run-'))
    const outside = join(tmpdir(), 'vyotiq-mcp-elsewhere', 'notes.md')
    beginWriteCheckpoint(runDir, ws)
    const appended: ChatMessage[] = []
    try {
      const result = await executeStepToolCalls(
        [
          {
            id: 'c1',
            name: 'mcp__filesystem__write_file',
            arguments: JSON.stringify({ path: outside, content: 'x' })
          }
        ],
        {
          runId: 'r',
          runDir,
          workspace: ws,
          signal: new AbortController().signal,
          appendMessage: async (m) => {
            appended.push(m)
          },
          appendEvent: () => {},
          agentMode: 'agent'
        }
      )
      expect(invokeMcpTool).toHaveBeenCalledTimes(1)
      expect(appended.map((m) => m.toolCallId)).toEqual(['c1'])
      expect(result.messages[0]!.ok).toBe(true)
    } finally {
      discardWriteCheckpoint(runDir)
      rmSync(ws, { recursive: true, force: true })
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
