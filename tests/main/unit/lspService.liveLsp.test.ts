import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { execFile as execFileCallback } from 'child_process'
import { promisify } from 'util'
import { describe, expect, it } from 'vitest'
import { toolLsp } from '@main/agent/tools/lsp'
import { workspaceLspStatus, globalTsserverSdkPath } from '@main/workspace/lspService'

const execFile = promisify(execFileCallback)

/**
 * Live end-to-end probe: drives the real typescript-language-server child
 * through the product code path (detectServer → spawn → initialize →
 * didOpen → publishDiagnostics). Skips where no tls is on PATH (mirrors the
 * Ollama live-golden skip pattern).
 *
 * Set VYOTIQ_LSP_PROBE_WS to run against a fixed workspace — e.g. one whose
 * node_modules pins tls + TypeScript 7, so the initialize handshake can only
 * succeed via the tsserver.path initializationOptions fallback.
 */
async function tlsOnPath(): Promise<boolean> {
  try {
    const lookup = process.platform === 'win32' ? 'where.exe' : 'which'
    const { stdout } = await execFile(lookup, ['typescript-language-server'], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true
    })
    return stdout.trim().length > 0
  } catch {
    return false
  }
}

const live = await tlsOnPath()

function seedProbeWorkspace(root: string): void {
  writeFileSync(
    join(root, 'broken.ts'),
    'const bad: number = "definitely not a number"\nexport { bad }\n',
    'utf8'
  )
}

describe.skipIf(!live)('live LSP probe (typescript-language-server)', () => {
  it('initializes the real server and returns real diagnostics', async () => {
    const override = process.env.VYOTIQ_LSP_PROBE_WS
    const dir = override ?? mkdtempSync(join(tmpdir(), 'vyotiq-lsp-live-'))
    if (!existsSync(join(dir, 'broken.ts'))) seedProbeWorkspace(dir)

    try {
      const status = await workspaceLspStatus(dir, 'broken.ts')
      expect(status.kind).toBe('available')

      // Cold tsserver analysis can outlast lspService's 750ms diagnostics wait,
      // so poll: the publishDiagnostics map is served once tsserver reports.
      let result = await toolLsp(dir, { path: 'broken.ts', action: 'diagnostics' })
      for (let attempt = 0; attempt < 10 && !/error/i.test(result.content); attempt++) {
        // The initialize must never degrade to the pre-fix failure on any attempt.
        expect(result.content).not.toMatch(/Could not find a valid TypeScript installation/i)
        expect(result.content).not.toMatch(/provides no tsserver\.js/i)
        await new Promise((resolve) => setTimeout(resolve, 500))
        result = await toolLsp(dir, { path: 'broken.ts', action: 'diagnostics' })
      }
      expect(result.ok).toBe(true)
      expect(result.content).not.toMatch(/Could not find a valid TypeScript installation/i)
      expect(result.content).not.toMatch(/provides no tsserver\.js/i)
      // Real tsserver publishDiagnostics for the deliberate type error.
      expect(result.content).toMatch(/error/i)
      expect(result.content).toMatch(/number|string/i)
    } finally {
      if (!override) {
        // Windows: the tls child may still hold the fresh tmp dir; EPERM here
        // would mask the real assertions. Best-effort cleanup.
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          /* windows file lock */
        }
      }
    }
  }, 60_000)

  it('resolves the global SDK fallback when no local typescript exists', () => {
    // The machine-dependent guarantee behind the initializationOptions wiring.
    expect(globalTsserverSdkPath(null)).not.toBeNull()
  })
})
