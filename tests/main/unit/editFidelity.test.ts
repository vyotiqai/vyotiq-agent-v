import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { toolStrReplace } from '@main/agent/tools/strReplace'
import { applyUnifiedDiff, toolEdit } from '@main/agent/tools/edit'
import { toolEditNotebook } from '@main/agent/tools/editNotebook'
import { applyLspRenameEdits } from '@main/agent/tools/lsp'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-edit-fidelity-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('replacement text is literal', () => {
  it("str_replace does not expand $' / $& / $$", () => {
    writeFileSync(join(root, 's.sh'), 'IFS=OLD\necho done\n', 'utf8')
    toolStrReplace(root, 's.sh', 'OLD', "$'\\n'")
    expect(readFileSync(join(root, 's.sh'), 'utf8')).toBe("IFS=$'\\n'\necho done\n")

    writeFileSync(join(root, 'p.svelte'), 'let x = PROPS\n', 'utf8')
    toolStrReplace(root, 'p.svelte', 'PROPS', '$$props $& $`')
    expect(readFileSync(join(root, 'p.svelte'), 'utf8')).toBe('let x = $$props $& $`\n')
  })

  it('edit_notebook does not expand $$ in new_string', () => {
    writeFileSync(
      join(root, 'n.ipynb'),
      `${JSON.stringify({ nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source: ['x = OLD'], metadata: {}, outputs: [], execution_count: null }] }, null, 1)}\n`,
      'utf8'
    )
    toolEditNotebook(root, { target_notebook: 'n.ipynb', cell_idx: 0, old_string: 'OLD', new_string: "'$$'" })
    const nb = JSON.parse(readFileSync(join(root, 'n.ipynb'), 'utf8')) as { cells: Array<{ source: string[] }> }
    expect(nb.cells[0]!.source.join('')).toBe("x = '$$'")
  })
})

describe('line endings and BOM', () => {
  it('keeps a mostly-LF file LF when one line is CRLF', () => {
    writeFileSync(join(root, 'm.txt'), 'a\nb\nc\r\nd\n', 'utf8')
    toolStrReplace(root, 'm.txt', 'a', 'A')
    expect(readFileSync(join(root, 'm.txt'), 'utf8')).toBe('A\nb\nc\nd\n')
    expect(applyUnifiedDiff('a\nb\nc\r\nd\n', '@@ -1,1 +1,1 @@\n-a\n+A\n')).toBe('A\nb\nc\nd\n')
  })

  it('still writes a CRLF file back as CRLF', () => {
    expect(applyUnifiedDiff('a\r\nb\r\nc\n', '@@ -1,1 +1,1 @@\n-a\n+A\n')).toBe('A\r\nb\r\nc\r\n')
  })

  it('applies a line-1 hunk to a BOM file and keeps the BOM', () => {
    writeFileSync(join(root, 'bom.ts'), '\uFEFFimport a\nconst b = 1\n', 'utf8')
    toolEdit(root, 'bom.ts', undefined, '@@ -1,2 +1,2 @@\n import a\n-const b = 1\n+const b = 2\n')
    expect(readFileSync(join(root, 'bom.ts'), 'utf8')).toBe('\uFEFFimport a\nconst b = 2\n')
    toolStrReplace(root, 'bom.ts', 'const b = 2', 'const b = 3')
    expect(readFileSync(join(root, 'bom.ts'), 'utf8')).toBe('\uFEFFimport a\nconst b = 3\n')
  })
})

describe('refused edits leave no directories behind', () => {
  it('binary-path refusal', () => {
    expect(() => toolEdit(root, 'x/y/z/model.bin', 'data')).toThrow(/binary path/)
    expect(existsSync(join(root, 'x'))).toBe(false)
  })

  it('unparseable diff for a new file', () => {
    expect(() => toolEdit(root, 'q/r/new.ts', undefined, 'not a diff')).toThrow(/No unified-diff hunks/)
    expect(existsSync(join(root, 'q'))).toBe(false)
  })

  it('still creates parents for a real new file', () => {
    toolEdit(root, 'deep/dir/new.ts', 'export {}\n')
    expect(readFileSync(join(root, 'deep', 'dir', 'new.ts'), 'utf8')).toBe('export {}\n')
  })
})

describe.runIf(process.platform !== 'win32')('file mode survives a rewrite', () => {
  it('keeps the executable bit through edit, str_replace and edit_notebook', () => {
    const script = join(root, 'build.sh')
    writeFileSync(script, '#!/bin/sh\necho one\n', 'utf8')
    chmodSync(script, 0o755)
    toolStrReplace(root, 'build.sh', 'one', 'two')
    expect(statSync(script).mode & 0o777).toBe(0o755)
    toolEdit(root, 'build.sh', undefined, '@@ -2,1 +2,1 @@\n-echo two\n+echo three\n')
    expect(statSync(script).mode & 0o777).toBe(0o755)
    toolEdit(root, 'build.sh', '#!/bin/sh\necho four\n')
    expect(statSync(script).mode & 0o777).toBe(0o755)
  })
})

describe('edit_notebook keeps the file indent', () => {
  const nb = { nbformat: 4, nbformat_minor: 5, metadata: {}, cells: [{ cell_type: 'code', source: ['a = 1'], metadata: {}, outputs: [], execution_count: null }] }

  it('re-serializes a Jupyter (indent 1) notebook with indent 1', () => {
    const text = `${JSON.stringify(nb, null, 1)}\n`
    writeFileSync(join(root, 'j.ipynb'), text, 'utf8')
    toolEditNotebook(root, { target_notebook: 'j.ipynb', cell_idx: 0, old_string: 'a = 1', new_string: 'a = 2' })
    expect(readFileSync(join(root, 'j.ipynb'), 'utf8')).toBe(text.replace('a = 1', 'a = 2'))
  })

  it('keeps indent 2 when the file used 2', () => {
    const text = `${JSON.stringify(nb, null, 2)}\n`
    writeFileSync(join(root, 'k.ipynb'), text, 'utf8')
    toolEditNotebook(root, { target_notebook: 'k.ipynb', cell_idx: 0, old_string: 'a = 1', new_string: 'a = 2' })
    expect(readFileSync(join(root, 'k.ipynb'), 'utf8')).toBe(text.replace('a = 1', 'a = 2'))
  })
})

describe('lsp rename that fails partway', () => {
  it('names the files already written', async () => {
    writeFileSync(join(root, 'a.ts'), 'const foo = 1\n', 'utf8')
    const edit = { startLine: 0, startCharacter: 6, endLine: 0, endCharacter: 9, newText: 'bar' }
    await expect(
      applyLspRenameEdits(root, [
        { path: 'a.ts', ...edit },
        { path: 'missing.ts', ...edit }
      ])
    ).rejects.toThrow(/partially applied — already written: a\.ts/)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const bar = 1\n')
  })
})
