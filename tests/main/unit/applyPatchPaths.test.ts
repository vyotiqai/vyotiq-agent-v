import { describe, expect, it } from 'vitest'
import { isBinaryGitPatch, patchTouchedPaths } from '@main/agent/tools/applyPatch'

// git_apply snapshots these before it runs, and path_scope instances are held
// to them, so a path this misses is a write nothing can undo or scope.
describe('patchTouchedPaths', () => {
  it('names modified, created, deleted and renamed files', () => {
    const patch = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1 +1 @@',
      '-a',
      '+b',
      'diff --git a/src/new.ts b/src/new.ts',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/src/new.ts',
      '@@ -0,0 +1 @@',
      '+x',
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-x',
      'diff --git a/old name.ts b/new name.ts',
      'similarity index 100%',
      'rename from old name.ts',
      'rename to new name.ts'
    ].join('\r\n')
    expect(patchTouchedPaths(patch)).toEqual([
      { path: 'src/a.ts', kind: 'write' },
      { path: 'src/new.ts', kind: 'write' },
      { path: 'src/gone.ts', kind: 'delete' },
      { path: 'old name.ts', kind: 'delete' },
      { path: 'new name.ts', kind: 'write' }
    ])
  })

  it('reads quoted paths and drops a trailing timestamp', () => {
    const patch = ['--- "a/sp ace.ts"\t2026-09-28', '+++ "b/sp ace.ts"\t2026-09-28', '@@ -1 +1 @@'].join('\n')
    expect(patchTouchedPaths(patch)).toEqual([{ path: 'sp ace.ts', kind: 'write' }])
  })

  // A removed line reading `-- x` renders as `--- x` and an added `++ y` as
  // `+++ y`, so a hunk body can carry the exact bytes of a file header pair.
  it('names one path when a hunk body line reads as a file header', () => {
    const patch = [
      'diff --git a/src/b.ts b/src/b.ts',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -1,3 +1,3 @@',
      ' const sql = 1',
      '--- old sql comment',
      '-const query = "select 1"',
      '+++ real new line',
      '+const query = "select 2"',
      ' console.log(sql)'
    ].join('\n')
    expect(patchTouchedPaths(patch)).toEqual([{ path: 'src/b.ts', kind: 'write' }])
  })

  it('still reads a deleted file whose body line reads as a file header', () => {
    const patch = [
      'diff --git a/src/gone.ts b/src/gone.ts',
      'deleted file mode 100644',
      '--- a/src/gone.ts',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '--- old sql comment',
      '-x'
    ].join('\n')
    expect(patchTouchedPaths(patch)).toEqual([{ path: 'src/gone.ts', kind: 'delete' }])
  })

  // A binary patch is exactly why the scope guard refuses an empty list: git
  // encodes the paths inside its base85 blocks, so no header exposes them.
  describe('isBinaryGitPatch', () => {
    it('flags a GIT binary patch and no unified patch', () => {
      const binary = [
        'diff --git a/logo.png b/logo.png',
        'index 1234567..89abcde 100644',
        'GIT binary patch',
        'literal 12',
        'KcmZQzU?ajOR)bKUD+wsQPAeIUl'
      ].join('\n')
      expect(isBinaryGitPatch(binary)).toBe(true)
      expect(isBinaryGitPatch('literal 12\r\nKcmZQzU?ajOR)bKUD+wsQPAeIUl')).toBe(false)
      expect(
        isBinaryGitPatch(
          'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@'
        )
      ).toBe(false)
    })

    it('extracts no paths from a binary patch', () => {
      const binary = [
        'diff --git a/logo.png b/logo.png',
        'GIT binary patch',
        'literal 12',
        'KcmZQzU?ajOR)bKUD+wsQPAeIUl'
      ].join('\n')
      expect(patchTouchedPaths(binary)).toEqual([])
    })
  })
})
