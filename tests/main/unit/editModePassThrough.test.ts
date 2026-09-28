import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const { atomicWriteFile } = vi.hoisted(() => ({ atomicWriteFile: vi.fn() }))
vi.mock('@main/storage/atomicWrite', async (importOriginal) => {
  const actual = (await importOriginal()) as { atomicWriteFile: (...a: unknown[]) => void }
  atomicWriteFile.mockImplementation((...a: unknown[]) => actual.atomicWriteFile(...a))
  return { ...(actual as object), atomicWriteFile }
})

import { toolStrReplace } from '@main/agent/tools/strReplace'
import { toolEdit } from '@main/agent/tools/edit'
import { toolEditNotebook } from '@main/agent/tools/editNotebook'
import { applyLspRenameEdits } from '@main/agent/tools/lsp'

/**
 * atomicWriteFile stamps 0o644 unless told otherwise, which stripped +x from
 * edited scripts on POSIX. Every rewrite of an existing file must hand it the
 * file's own mode (checked here on every platform via the call itself).
 */
let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-edit-mode-'))
  atomicWriteFile.mockClear()
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function lastMode(): unknown {
  return atomicWriteFile.mock.calls.at(-1)?.[2]
}

describe('rewrites pass the existing file mode', () => {
  it('str_replace, edit (contents and diff), edit_notebook and lsp rename', async () => {
    const file = join(root, 'a.ts')
    writeFileSync(file, 'const foo = 1\n', 'utf8')
    const mode = statSync(file).mode & 0o777

    toolStrReplace(root, 'a.ts', '1', '2')
    expect(lastMode()).toBe(mode)
    toolEdit(root, 'a.ts', undefined, '@@ -1,1 +1,1 @@\n-const foo = 2\n+const foo = 3\n')
    expect(lastMode()).toBe(mode)
    toolEdit(root, 'a.ts', 'const foo = 4\n')
    expect(lastMode()).toBe(mode)
    await applyLspRenameEdits(root, [
      { path: 'a.ts', startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 9, newText: 'bar' }
    ])
    expect(lastMode()).toBe(mode)

    writeFileSync(
      join(root, 'n.ipynb'),
      JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source: ['x'], metadata: {}, outputs: [], execution_count: null }] }),
      'utf8'
    )
    toolEditNotebook(root, { target_notebook: 'n.ipynb', cell_idx: 0, old_string: 'x', new_string: 'y' })
    expect(lastMode()).toBe(statSync(join(root, 'n.ipynb')).mode & 0o777)
  })

  it('a new file keeps the default', () => {
    toolEdit(root, 'new.ts', 'export {}\n')
    expect(lastMode()).toBeUndefined()
  })
})
