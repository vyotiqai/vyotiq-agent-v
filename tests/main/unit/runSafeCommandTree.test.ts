import { describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/settings/settings', () => ({ getSettings: () => ({ ...DEFAULT_SETTINGS }) }))

import { runSafeCommand } from '@main/agent/tools/diagnostics'

/**
 * run_tests / diagnostics go through runSafeCommand. An abort must end the
 * whole process tree and settle promptly — not wait for a grandchild that
 * inherited stdout (pnpm.cmd → cmd.exe → node on Windows).
 */
describe('runSafeCommand abort', () => {
  it('kills the tree behind a wrapper and resolves without waiting for it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'vyotiq-runsafe-'))
    try {
      const marker = join(dir, 'still-running.txt')
      const js = join(dir, 'slow.js')
      writeFileSync(
        js,
        `setTimeout(() => require('fs').writeFileSync(${JSON.stringify(marker)}, 'x'), 3000)\n`,
        'utf8'
      )
      let bin: string
      let args: string[]
      if (process.platform === 'win32') {
        // What cross-spawn does for a .cmd shim: cmd.exe /d /s /c "<shim>".
        bin = join(dir, 'runner.cmd')
        writeFileSync(bin, `@echo off\r\n"${process.execPath}" "${js}"\r\n`, 'utf8')
        args = []
      } else {
        // `; true` keeps sh from exec-ing node, so node is a grandchild.
        bin = 'sh'
        args = ['-c', `"${process.execPath}" "${js}"; true`]
      }
      const ac = new AbortController()
      const pending = runSafeCommand(bin, args, {
        cwd: dir,
        env: process.env,
        signal: ac.signal,
        timeoutMs: 60_000
      })
      await new Promise((r) => setTimeout(r, 1000))
      const abortedAt = Date.now()
      ac.abort()
      const result = await pending
      expect(result.killed).toBe(true)
      expect(Date.now() - abortedAt).toBeLessThan(1500)
      // Past the grandchild's 3s timer: it must be gone, not finishing its work.
      await new Promise((r) => setTimeout(r, 3500))
      expect(existsSync(marker)).toBe(false)
    } finally {
      await new Promise((r) => setTimeout(r, 200))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
