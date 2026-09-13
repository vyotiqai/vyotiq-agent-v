import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeTool } from '@main/agent/tools'

describe('unregistered image tool names', () => {
  const workspace = mkdtempSync(join(tmpdir(), 'vyotiq-img-gone-'))
  const signal = new AbortController().signal

  it('does not dispatch generate_image', async () => {
    const result = await executeTool(
      'generate_image',
      JSON.stringify({ prompt: 'vector logo' }),
      workspace,
      signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Unknown tool "generate_image"/)
  })

  it('does not dispatch edit_image', async () => {
    const result = await executeTool(
      'edit_image',
      JSON.stringify({ prompt: 'make it blue', reference_paths: ['a.png'] }),
      workspace,
      signal
    )
    expect(result.ok).toBe(false)
    expect(result.content).toMatch(/Unknown tool "edit_image"/)
  })
})
