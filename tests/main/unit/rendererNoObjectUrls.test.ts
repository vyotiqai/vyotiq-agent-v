import { readdirSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const RENDERER_SRC = join(process.cwd(), 'src', 'renderer', 'src')

function collectSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      collectSourceFiles(full, out)
    } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
      out.push(full)
    }
  }
  return out
}

describe('renderer object URLs (CSP dev/prod parity, audit L9)', () => {
  it('has zero createObjectURL call sites under src/renderer/src', () => {
    const offenders: string[] = []
    for (const file of collectSourceFiles(RENDERER_SRC)) {
      const text = readFileSync(file, 'utf8')
      if (!text.includes('createObjectURL')) continue
      const lines = text.split(/\r?\n/)
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('createObjectURL')) {
          offenders.push(`${file.replace(/\\/g, '/')}:${i + 1}: ${lines[i].trim()}`)
        }
      }
    }
    expect(
      offenders,
      'Renderer uses object URLs, so `blob:` is live in the dev CSP img-src ' +
        '(src/main/app/security.ts:104). Add `blob:` to the prod img-src there too ' +
        '(audit L9, AUDIT-REPORT-2026-09-10.md) — dev and prod must not diverge.'
    ).toEqual([])
  })
})
