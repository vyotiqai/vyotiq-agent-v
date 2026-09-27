import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({ diagnosticsCommand: '' })
}))

import { resolveDiagnosticsCommand } from '@main/agent/tools/diagnostics'

describe('resolveDiagnosticsCommand', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-diag-cmd-'))
  })

  afterEach(() => {
    rmSync(workspace, { recursive: true, force: true })
  })

  function writePackage(scripts: Record<string, string>): void {
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'x', scripts }))
  }

  // pnpm forwards everything after the script name to the script itself, so
  // `pnpm run lint --if-present` ran `eslint . --if-present` and eslint
  // exited 2 on the unknown option. The flag was never needed: this branch is
  // only taken when the lint script exists.
  it('runs an existing lint script with no forwarded flags under pnpm', () => {
    writePackage({ lint: 'eslint .' })
    writeFileSync(join(workspace, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    expect(resolveDiagnosticsCommand(workspace, 'lint', '')).toBe('pnpm run lint')
  })

  it('runs an existing lint script with no forwarded flags under npm', () => {
    writePackage({ lint: 'eslint .' })
    expect(resolveDiagnosticsCommand(workspace, 'lint', '')).toBe('npm run lint')
  })

  it('falls back to eslint JSON output when there is no lint script', () => {
    writePackage({})
    expect(resolveDiagnosticsCommand(workspace, 'lint', '')).toBe('npm exec -- eslint . --format json')
  })

  it('prefers the typecheck script, then type-check, then tsc', () => {
    writePackage({ typecheck: 'tsc -b' })
    expect(resolveDiagnosticsCommand(workspace, 'typecheck', '')).toBe('npm run typecheck')
    writePackage({ 'type-check': 'tsc -b' })
    expect(resolveDiagnosticsCommand(workspace, 'typecheck', '')).toBe('npm run type-check')
    writePackage({})
    expect(resolveDiagnosticsCommand(workspace, 'typecheck', '')).toBe(
      'npm exec -- tsc --noEmit --pretty false'
    )
  })

  it('uses the configured override verbatim', () => {
    writePackage({ lint: 'eslint .' })
    expect(resolveDiagnosticsCommand(workspace, 'lint', '  make check  ')).toBe('make check')
  })
})
