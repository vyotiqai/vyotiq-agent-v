import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

import { toolStrReplace } from '@main/agent/tools/strReplace'

let workspace: string

beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), 'vyotiq-strreplaceline-'))
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
})

describe('toolStrReplace result line', () => {
  it('reports the line of a match part-way down a multi-line file', () => {
    const file = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')
    writeFileSync(join(workspace, 'a.txt'), `${file}\n`, 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'seven', 'SEVEN')
    expect(out).toBe('Replaced 1 occurrence in a.txt (line 7)')
    expect(out.endsWith('(line 7)')).toBe(true)
  })

  it('reports line 1 when the match is on the first line', () => {
    writeFileSync(join(workspace, 'a.txt'), 'alpha\nbeta\ngamma\n', 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'alpha', 'delta')
    expect(out).toBe('Replaced 1 occurrence in a.txt (line 1)')
  })

  it('reports the first match when replace_all hits two occurrences', () => {
    writeFileSync(join(workspace, 'a.txt'), 'dup\nkeep\ndup\nkeep\n', 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'dup', 'x', true)
    expect(out).toBe('Replaced 2 occurrences in a.txt (line 1)')
  })

  it('reports the first match line when replace_all hits occurrences further down', () => {
    const file = ['a', 'b', 'c', 'dup', 'e', 'dup'].join('\n')
    writeFileSync(join(workspace, 'a.txt'), `${file}\n`, 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'dup', 'x', true)
    expect(out).toBe('Replaced 2 occurrences in a.txt (line 4)')
  })

  it('counts lines on the normalized text so CRLF does not shift the number', () => {
    writeFileSync(join(workspace, 'a.txt'), 'one\r\ntwo\r\nthree\r\nfour\r\n', 'utf8')
    const out = toolStrReplace(workspace, 'a.txt', 'three', 'THREE')
    expect(out).toBe('Replaced 1 occurrence in a.txt (line 3)')
  })
})
