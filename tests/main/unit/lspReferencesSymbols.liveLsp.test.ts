import { mkdtempSync, writeFileSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile as execFileCallback } from 'child_process'
import { promisify } from 'util'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { toolLsp } from '@main/agent/tools/lsp'
import { disposeWorkspaceLsp } from '@main/workspace/lspService'

const execFile = promisify(execFileCallback)

async function tlsOnPath(): Promise<boolean> {
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await execFile(lookup, ['typescript-language-server'], { encoding: 'utf8', timeout: 5_000, windowsHide: true })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

const live = await tlsOnPath()

/**
 * references / document_symbols / workspace_symbols against the real
 * typescript-language-server, through the product path. Skips where it is
 * not on PATH, like the other live LSP probe.
 */
describe.skipIf(!live)('live LSP references and symbols', () => {
  let dir: string

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'vyotiq-lsp-refs-'))
    writeFileSync(join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true, module: 'esnext', target: 'es2022' }, include: ['*.ts'] }))
    // greet is declared on line 1 (0-based 1), character 16.
    writeFileSync(join(dir, 'greet.ts'), '// greeting helpers\nexport function greet(name: string): string {\n  return `hi ${name}`\n}\n\nexport class Greeter {\n  hello(): string {\n    return greet("x")\n  }\n}\n')
    writeFileSync(join(dir, 'use.ts'), 'import { greet } from "./greet"\n\nexport const a = greet("a")\nexport const b = greet("b")\n')
  })

  afterAll(async () => {
    try {
      disposeWorkspaceLsp(dir)
    } catch {
      // already gone
    }
    // The server is killed asynchronously and holds the folder until it is gone (Windows EPERM).
    await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 250 })
  })

  it('finds every use of a function across files', async () => {
    let result = await toolLsp(dir, { path: 'greet.ts', action: 'references', line: 1, character: 16 })
    // A cold tsserver may answer before it has loaded use.ts; ask again until it has.
    for (let i = 0; i < 10 && !result.content.includes('use.ts'); i++) {
      await new Promise((r) => setTimeout(r, 500))
      result = await toolLsp(dir, { path: 'greet.ts', action: 'references', line: 1, character: 16 })
    }
    expect(result.ok).toBe(true)
    const lines = result.content.split('\n').sort()
    expect(lines).toEqual(expect.arrayContaining(['greet.ts:2:17', 'greet.ts:8:12', 'use.ts:1:10', 'use.ts:3:18', 'use.ts:4:18']))
  }, 60_000)

  it('outlines a file, nesting members under their class', async () => {
    const result = await toolLsp(dir, { path: 'greet.ts', action: 'document_symbols' })
    expect(result.ok).toBe(true)
    expect(result.content).toContain('function greet — greet.ts:2:17')
    expect(result.content).toContain('class Greeter — greet.ts:6:14')
    expect(result.content).toContain('method hello in Greeter — greet.ts:7:3')
  }, 60_000)

  it('searches symbols by name across the project, and needs a query', async () => {
    let result = await toolLsp(dir, { path: 'use.ts', action: 'workspace_symbols', query: 'Greeter' })
    for (let i = 0; i < 10 && !result.content.includes('Greeter'); i++) {
      await new Promise((r) => setTimeout(r, 500))
      result = await toolLsp(dir, { path: 'use.ts', action: 'workspace_symbols', query: 'Greeter' })
    }
    // workspace/symbol answers with the whole declaration's range, so the
    // column is where the declaration starts, not the name.
    expect(result.content).toMatch(/class Greeter — greet\.ts:6:\d+/)
    const missing = await toolLsp(dir, { path: 'use.ts', action: 'workspace_symbols' })
    expect(missing).toMatchObject({ ok: false, content: 'workspace_symbols requires query' })
  }, 60_000)
})
