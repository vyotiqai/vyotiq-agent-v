import { describe, expect, it } from 'vitest'
import { groupFilesByRoot } from '@renderer/features/inspector/ChangesColumn'

describe('Changes grouping', () => {
  it('groups added-folder files under their folder after the workspace files', () => {
    const files = [
      { path: 'src/a.ts', status: 'M' as const },
      { path: 'C:/work/backend/src/b.ts', status: 'A' as const },
      { path: '/elsewhere/c.ts', status: 'M' as const }
    ]
    const groups = groupFilesByRoot(files, ['C:\\work\\backend'])
    expect(groups.map((g) => g.root)).toEqual([null, 'C:\\work\\backend', 'Outside the workspace'])
    expect(groupFilesByRoot([{ path: 'a.ts', status: 'M' }])).toEqual([{ root: null, files: [{ path: 'a.ts', status: 'M' }] }])
  })
})
