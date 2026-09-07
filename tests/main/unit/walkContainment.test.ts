import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import {
  CODE_INDEX_EXTS,
  collectWorkspaceFiles,
  collectWorkspaceFilesPage,
  IGNORED_DIRS,
  INDEX_SKIP_DIR_SEGMENTS,
  isDenseIndexPath,
  isIndexableSourcePath,
  isIndexClutterFileName,
  isGrepOverlapRel,
  TEXT_EXTS
} from '@main/agent/tools/walk'

const canSymlink = (() => {
  if (process.platform === 'win32') return false
  const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-symlink-probe-'))
  try {
    const target = join(root, 't.txt')
    writeFileSync(target, 'x', 'utf8')
    symlinkSync(target, join(root, 'link.txt'), 'file')
    return true
  } catch {
    return false
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})()

describe('collectWorkspaceFiles', () => {
  it('lists normal files inside the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'const x = 1', 'utf8')
      mkdirSync(join(root, 'src'))
      writeFileSync(join(root, 'src', 'b.ts'), 'export {}', 'utf8')
      const files = await collectWorkspaceFiles(root, 100)
      const rels = files.map((f) => f.rel).sort()
      expect(rels).toEqual(['a.ts', 'src/b.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('skips lockfiles and minified dumps but still lists tests', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-clutter-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'export const a = 1\n', 'utf8')
      writeFileSync(join(root, 'a.test.ts'), 'export const t = 1\n', 'utf8')
      writeFileSync(join(root, 'vendor.min.js'), '/* min */\n', 'utf8')
      writeFileSync(join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n', 'utf8')
      writeFileSync(join(root, 'app.js.map'), '{"version":3}\n', 'utf8')
      const files = await collectWorkspaceFiles(root, 100, undefined, TEXT_EXTS)
      expect(files.map((f) => f.rel).sort()).toEqual(['a.test.ts', 'a.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('optional exts only count matching files toward the cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-exts-'))
    try {
      writeFileSync(join(root, 'a.ts'), 'const x = 1', 'utf8')
      writeFileSync(join(root, 'blob.bin'), 'xxxx', 'utf8')
      writeFileSync(join(root, 'b.ts'), 'export {}', 'utf8')
      const files = await collectWorkspaceFiles(root, 1, undefined, TEXT_EXTS)
      expect(files).toHaveLength(1)
      expect(files[0]?.rel.endsWith('.ts')).toBe(true)
      expect(files.every((f) => !f.rel.endsWith('.bin'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('skips file symlinks that escape the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-walk-out-'))
    try {
      writeFileSync(join(outside, 'secret.txt'), 'outside-secret', 'utf8')
      writeFileSync(join(root, 'ok.ts'), 'ok', 'utf8')
      symlinkSync(join(outside, 'secret.txt'), join(root, 'link.txt'), 'file')
      const files = await collectWorkspaceFiles(root, 100)
      expect(files.map((f) => f.rel)).toEqual(['ok.ts'])
      expect(files.every((f) => !f.full.includes('secret'))).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it.skipIf(!canSymlink)('skips directory symlinks that escape the workspace', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-'))
    const outside = mkdtempSync(join(tmpdir(), 'vyotiq-walk-out-'))
    try {
      writeFileSync(join(outside, 'secret.ts'), 'export const secret = 1', 'utf8')
      writeFileSync(join(root, 'ok.ts'), 'ok', 'utf8')
      symlinkSync(outside, join(root, 'escape'), 'dir')
      const files = await collectWorkspaceFiles(root, 100)
      expect(files.map((f) => f.rel)).toEqual(['ok.ts'])
      expect(files.some((f) => f.rel.includes('secret') || f.rel.includes('escape'))).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('collectWorkspaceFilesPage resume', () => {
  it('resumes in walk order so a later lex-smaller path is not skipped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-page-'))
    try {
      writeFileSync(join(root, 'zzz.ts'), 'export const z = 1\n', 'utf8')
      mkdirSync(join(root, 'z'))
      writeFileSync(join(root, 'z', 'aaa.ts'), 'export const a = 1\n', 'utf8')
      const first = await collectWorkspaceFilesPage(root, 1, undefined, undefined, TEXT_EXTS)
      expect(first.files).toHaveLength(1)
      expect(first.exhausted).toBe(false)
      expect(first.lastRel).toBe('zzz.ts')

      const second = await collectWorkspaceFilesPage(root, 10, first.lastRel ?? undefined, undefined, TEXT_EXTS)
      expect(second.files.map((f) => f.rel)).toContain('z/aaa.ts')
      expect(second.cursorMissing).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('CODE_INDEX_EXTS', () => {
  it('keeps production source languages, drops docs/config/style/scripts/data', () => {
    expect(CODE_INDEX_EXTS.has('.ts')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.py')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.go')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.rb')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.php')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.dart')).toBe(true)
    expect(CODE_INDEX_EXTS.has('.md')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.mdc')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.mdx')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.json')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.css')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.yml')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.yaml')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.txt')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.sh')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.ps1')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.sql')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.proto')).toBe(false)
    expect(CODE_INDEX_EXTS.has('.ipynb')).toBe(false)
    expect(TEXT_EXTS.has('.json')).toBe(true)
    expect(TEXT_EXTS.has('.css')).toBe(true)
    expect(TEXT_EXTS.has('.md')).toBe(true)
    expect(TEXT_EXTS.has('.php')).toBe(true)
  })
})

describe('index clutter filters', () => {
  it('flags lockfiles, minified, maps, snapshots, and codegen names', () => {
    expect(isIndexClutterFileName('pnpm-lock.yaml')).toBe(true)
    expect(isIndexClutterFileName('src/vendor.min.js')).toBe(true)
    expect(isIndexClutterFileName('app.js.map')).toBe(true)
    expect(isIndexClutterFileName('Button.test.tsx.snap')).toBe(true)
    expect(isIndexClutterFileName('api.generated.ts')).toBe(true)
    expect(isIndexClutterFileName('types.gen.ts')).toBe(true)
    expect(isIndexClutterFileName('msg.pb.go')).toBe(true)
    expect(isIndexClutterFileName('msg_pb2.py')).toBe(true)
    expect(isIndexClutterFileName('src/auth.ts')).toBe(false)
    expect(isIndexClutterFileName('src/auth.test.ts')).toBe(false)
  })

  it('indexes production source only — not tests, docs, configs, scripts, or databases', () => {
    expect(isIndexableSourcePath('src/auth.ts')).toBe(true)
    expect(isDenseIndexPath('src/auth.ts')).toBe(true)
    expect(isIndexableSourcePath('pkg/foo.go')).toBe(true)
    expect(isIndexableSourcePath('lib/auth.py')).toBe(true)
    expect(isIndexableSourcePath('svc/Contest.java')).toBe(true)
    expect(isIndexableSourcePath('app/models/user.rb')).toBe(true)
    expect(isIndexableSourcePath('src/User.php')).toBe(true)
    expect(isIndexableSourcePath('lib/auth.dart')).toBe(true)

    expect(isIndexableSourcePath('src/auth.test.ts')).toBe(false)
    expect(isIndexableSourcePath('src/__tests__/auth.ts')).toBe(false)
    expect(isIndexableSourcePath('tests/main/unit/walk.ts')).toBe(false)
    expect(isIndexableSourcePath('src/Button.stories.tsx')).toBe(false)
    expect(isIndexableSourcePath('pkg/foo_test.go')).toBe(false)
    expect(isIndexableSourcePath('lib/test_auth.py')).toBe(false)
    expect(isIndexableSourcePath('lib/auth_test.py')).toBe(false)
    expect(isIndexableSourcePath('lib/conftest.py')).toBe(false)
    expect(isIndexableSourcePath('svc/AuthServiceTest.java')).toBe(false)
    expect(isIndexableSourcePath('src/testing/helpers.ts')).toBe(false)
    expect(isIndexableSourcePath('app/UserTest.php')).toBe(false)

    expect(isIndexableSourcePath('README.md')).toBe(false)
    expect(isIndexableSourcePath('docs/guide.ts')).toBe(false)
    expect(isIndexableSourcePath('CHANGELOG.mdx')).toBe(false)

    expect(isIndexableSourcePath('vite.config.ts')).toBe(false)
    expect(isIndexableSourcePath('app.config.ts')).toBe(false)
    expect(isIndexableSourcePath('.env')).toBe(false)
    expect(isIndexableSourcePath('src/vite-env.d.ts')).toBe(false)
    expect(isIndexableSourcePath('config/settings.ts')).toBe(false)

    expect(isIndexableSourcePath('examples/demo.ts')).toBe(false)
    expect(isIndexableSourcePath('scripts/release.ts')).toBe(false)
    expect(isIndexableSourcePath('benchmarks/hot.ts')).toBe(false)
    expect(isIndexableSourcePath('bin/setup.sh')).toBe(false)

    expect(isIndexableSourcePath('src/schema.sql')).toBe(false)
    expect(isIndexableSourcePath('src/migrations/001.sql')).toBe(false)
    expect(isIndexableSourcePath('data/seed.ts')).toBe(false)
    expect(isIndexableSourcePath('db/user.ts')).toBe(false)
    expect(isIndexableSourcePath('src/generated/api.ts')).toBe(false)
    expect(isIndexableSourcePath('src/logs/logger.ts')).toBe(false)

    // toolchain / vendor dir segments are never indexable
    expect(isIndexableSourcePath('.linux-vm/msys64/mingw64/include/EGL/egl.h')).toBe(false)
    expect(isIndexableSourcePath('.linux-vm/msys64/mingw64/bin/gdbus-codegen-script.py')).toBe(false)
    expect(isIndexableSourcePath('tools3/ucrt64/x.cpp')).toBe(false)
    expect(isIndexableSourcePath('pkg/clang64/lib.cpp')).toBe(false)

    // a token in a basename, or no token at all, stays indexable
    // (`.md` is never source-indexable — INDEX_EXCLUDE_EXTS — so use a code ext)
    expect(isIndexableSourcePath('src/msys64-notes.cpp')).toBe(true)
    expect(isIndexableSourcePath('lib/tool.mingw.rs')).toBe(true)
  })
})

describe('IGNORED_DIRS', () => {
  it('skips generated pack and test output directories', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-ignored-'))
    try {
      writeFileSync(join(root, 'ok.ts'), 'export const ok = 1\n', 'utf8')
      for (const name of [
        'dist-package',
        'dist-package-alt',
        'playwright-report',
        'test-results',
        '.output',
        '__snapshots__',
        '.vite',
        '.nuxt',
        'storybook-static',
        'target',
        'third_party',
        'deps',
        '.husky'
      ]) {
        expect(IGNORED_DIRS.has(name)).toBe(true)
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'hidden.ts'), 'export const hidden = 1\n', 'utf8')
      }
      const files = await collectWorkspaceFiles(root, 100, undefined, TEXT_EXTS)
      expect(files.map((f) => f.rel)).toEqual(['ok.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('INDEX_SKIP_DIR_SEGMENTS', () => {
  it('index walks skip tests/docs/config/scripts/data folders', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vyotiq-walk-index-skip-'))
    try {
      mkdirSync(join(root, 'src'), { recursive: true })
      writeFileSync(join(root, 'src', 'ok.ts'), 'export const ok = 1\n', 'utf8')
      for (const name of ['tests', 'docs', 'config', 'scripts', 'data', 'db']) {
        expect(INDEX_SKIP_DIR_SEGMENTS.has(name)).toBe(true)
        mkdirSync(join(root, name), { recursive: true })
        writeFileSync(join(root, name, 'hidden.ts'), 'export const hidden = 1\n', 'utf8')
      }
      const files = await collectWorkspaceFiles(
        root,
        100,
        undefined,
        CODE_INDEX_EXTS,
        INDEX_SKIP_DIR_SEGMENTS
      )
      expect(files.map((f) => f.rel)).toEqual(['src/ok.ts'])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe('isGrepOverlapRel', () => {
  it('keeps docs and tests/ text that the source index omits', () => {
    expect(isGrepOverlapRel('docs/guide.md')).toBe(true)
    expect(isGrepOverlapRel('notes.md.docx')).toBe(true)
    expect(isGrepOverlapRel('tests/main/unit/webFetch.test.ts')).toBe(true)
    expect(isGrepOverlapRel('src/webFetch.ts')).toBe(false)
  })
})
