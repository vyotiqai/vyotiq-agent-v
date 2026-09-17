import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// buildTool resolves the tools dir via app.getPath('userData') — stub it to a
// temp tree, like tests/main/unit/skillTool.test.ts does.
const tempRoot = mkdtempSync(join(tmpdir(), 'vyotiq-agent-tools-buildtool-'))
vi.mock('electron', () => ({
  app: { getPath: () => tempRoot }
}))

describe('build_tool handler', () => {
  beforeEach(() => {
    rmSync(join(tempRoot, 'agent-tools'), { recursive: true, force: true })
  })

  afterEach(() => {
    rmSync(join(tempRoot, 'agent-tools'), { recursive: true, force: true })
  })

  const validInput = (overrides: Record<string, unknown> = {}) => ({
    name: 'my-tool',
    description: 'Adds two numbers',
    schema: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b']
    },
    code: 'export async function handler(args) {\n  return { sum: args.a + args.b }\n}\n',
    ...overrides
  })

  it('writes a valid .mjs with header + handler into the tools dir', async () => {
    const { handler } = await import('@main/agent/tools/buildTool')
    const res = await handler(validInput())

    const expectedDir = join(tempRoot, 'agent-tools')
    expect(res.written).toBe(join(expectedDir, 'my-tool.mjs'))

    const source = readFileSync(res.written, 'utf8')
    expect(source).toContain('/* @agent-tool')
    expect(source).toContain('"name": "my-tool"')
    expect(source).toContain('"description": "Adds two numbers"')
    expect(source).toContain('"inputSchema"')
    expect(source).toContain('export async function handler')

    // The header must be parseable JSON inside the comment and round-trip
    // through the real loader.
    const { scanAgentTools } = await import('@main/agent/agentTools/loader')
    const defs = await scanAgentTools(expectedDir)
    expect(defs).toHaveLength(1)
    expect(defs[0]!.name).toBe('my-tool')
    expect(defs[0]!.description).toBe('Adds two numbers')
    expect(defs[0]!.inputSchema).toEqual(validInput().schema)
  })

  it('refuses to overwrite an existing file unless overwrite: true', async () => {
    const { handler } = await import('@main/agent/tools/buildTool')
    const first = await handler(validInput())
    expect(() => readFileSync(first.written, 'utf8')).toBeTruthy()

    await expect(handler(validInput({ description: 'changed' }))).rejects.toThrow(
      /already exists.*overwrite: true/s
    )
    expect(readFileSync(first.written, 'utf8')).toContain('Adds two numbers')

    const overwritten = await handler(validInput({ description: 'changed', overwrite: true }))
    expect(overwritten.written).toBe(first.written)
    expect(readFileSync(first.written, 'utf8')).toContain('changed')
  })

  it('rejects invalid names, empty code, missing handler, and bad schema', async () => {
    const { handler } = await import('@main/agent/tools/buildTool')
    await expect(handler(validInput({ name: '' }))).rejects.toThrow(/Invalid tool name/)
    await expect(handler(validInput({ name: 'a'.repeat(33) }))).rejects.toThrow(/Invalid tool name/)
    await expect(handler(validInput({ name: 'Bad Name!' }))).rejects.toThrow(/Invalid tool name/)
    await expect(handler(validInput({ code: 'const x = 1' }))).rejects.toThrow(
      /must export async function handler/
    )
    await expect(handler(validInput({ code: '   ' }))).rejects.toThrow(/non-empty code/)
    await expect(handler(validInput({ schema: 'nope' }))).rejects.toThrow(/schema to be a JSON object/)
    await expect(handler(validInput({ description: '  ' }))).rejects.toThrow(/non-empty description/)
    await expect(handler(null)).rejects.toThrow(/requires an input object/)
  })

  it('refuses a description that would break the header comment', async () => {
    const { handler } = await import('@main/agent/tools/buildTool')
    await expect(handler(validInput({ description: 'ends with */' }))).rejects.toThrow(
      /must not contain the sequence \*\//
    )
  })

  it('normalizes name case and rejects invalid names', async () => {
    const { handler } = await import('@main/agent/tools/buildTool')
    const { pathSafeName } = await import('@main/agent/agentTools/paths')
    expect(pathSafeName('My-Tool_2')).toBe('my-tool_2')
    expect(pathSafeName('')).toBeNull()
    expect(pathSafeName('has space')).toBeNull()
    const res = await handler(validInput({ name: 'UPPER_case' }))
    expect(res.written).toContain('upper_case.mjs')
  })
})
