import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const userData = mkdtempSync(join(tmpdir(), 'vyotiq-file-service-userdata-'))

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return userData
      throw new Error(`unexpected getPath(${name})`)
    }
  }
}))

import {
  clearEditorRecovery,
  createWorkspaceFile,
  deleteWorkspaceFile,
  listWorkspaceDirectory,
  loadEditorRecovery,
  moveWorkspaceFile,
  readWorkspaceFile,
  readWorkspaceAttachmentBytes,
  saveEditorRecovery,
  saveWorkspaceFile,
  WorkspaceFileError
} from '@main/workspace/fileService'
import type { WorkspaceEditorRecoverySnapshot } from '@shared/ipc'
import {
  WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES,
  WORKSPACE_FILE_BINARY_MAX_BYTES,
  MAX_ATTACHMENT_BYTES
} from '@shared/ipc'

let root: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vyotiq-file-service-'))
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'note.ts'), 'one\r\ntwo\r\n', 'utf8')
  writeFileSync(join(root, '.hidden'), 'hidden', 'utf8')
  mkdirSync(join(root, 'node_modules'), { recursive: true })
  writeFileSync(join(root, 'node_modules', 'package.json'), '{}', 'utf8')
  mkdirSync(join(root, '.git'), { recursive: true })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
}, 60_000)

afterAll(() => {
  rmSync(userData, { recursive: true, force: true })
})

describe('workspace file service', () => {
  it('lists hidden and ignored entries with stable pagination', async () => {
    const first = await listWorkspaceDirectory({
      workspacePath: root,
      path: '',
      offset: 0,
      limit: 2
    })
    expect(first.entries).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    const all: string[] = []
    let offset = 0
    let nextOffset: number | null = 0
    while (nextOffset !== null) {
      const page = await listWorkspaceDirectory({
        workspacePath: root,
        path: '',
        offset,
        limit: 2
      })
      all.push(...page.entries.map((entry) => entry.path))
      nextOffset = page.nextOffset
      offset = nextOffset ?? page.total
    }
    expect(all).toContain('.hidden')
    expect(all).toContain('.git')
    expect(all).toContain('node_modules')
  })

  it('continues paging through the bounded directory cap', async () => {
    for (let index = 0; index < 10_001; index++) {
      writeFileSync(join(root, `cap-${String(index).padStart(5, '0')}.txt`), '')
    }
    const page = await listWorkspaceDirectory({
      workspacePath: root,
      path: '',
      offset: 9_700,
      limit: 200
    })
    expect(page.entries).toHaveLength(200)
    expect(page.truncated).toBe(true)
    expect(page.nextOffset).toBe(9_900)
  })

  it('reads text losslessly enough to preserve CRLF metadata and detects binary bytes', async () => {
    const text = await readWorkspaceFile(root, 'src/note.ts')
    expect(text.kind).toBe('text')
    expect(text.content).toBe('one\r\ntwo\r\n')
    expect(text.eol).toBe('crlf')
    const separatorNormalized = await readWorkspaceFile(root, 'src\\note.ts')
    expect(separatorNormalized.content).toBe(text.content)

    writeFileSync(
      join(root, 'utf16le.txt'),
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from('utf16-le', 'utf16le')])
    )
    const utf16le = await readWorkspaceFile(root, 'utf16le.txt')
    expect(utf16le.kind).toBe('text')
    expect(utf16le.encoding).toBe('utf16le')
    expect(utf16le.content).toBe('utf16-le')

    const utf16beBody = Buffer.from('utf16-be', 'utf16le')
    for (let index = 0; index + 1 < utf16beBody.length; index += 2) {
      const byte = utf16beBody[index]
      utf16beBody[index] = utf16beBody[index + 1] ?? 0
      utf16beBody[index + 1] = byte ?? 0
    }
    writeFileSync(
      join(root, 'utf16be.txt'),
      Buffer.concat([Buffer.from([0xfe, 0xff]), utf16beBody])
    )
    const utf16be = await readWorkspaceFile(root, 'utf16be.txt')
    expect(utf16be.kind).toBe('text')
    expect(utf16be.encoding).toBe('utf16be')
    expect(utf16be.content).toBe('utf16-be')

    writeFileSync(join(root, 'utf16le-no-bom.txt'), Buffer.from('no-bom-le', 'utf16le'))
    const utf16leNoBom = await readWorkspaceFile(root, 'utf16le-no-bom.txt')
    expect(utf16leNoBom).toMatchObject({
      kind: 'text',
      encoding: 'utf16le',
      bom: false,
      content: 'no-bom-le'
    })
    await saveWorkspaceFile({
      workspacePath: root,
      path: 'utf16le-no-bom.txt',
      kind: 'text',
      content: 'updated-le',
      encoding: 'utf16le',
      eol: 'none',
      bom: false,
      expectedVersion: utf16leNoBom.version,
      replaceExisting: false
    })
    expect(readFileSync(join(root, 'utf16le-no-bom.txt'))).toEqual(
      Buffer.from('updated-le', 'utf16le')
    )

    const malformedUtf16 = Buffer.from([0xff, 0xfe, 0x41])
    writeFileSync(join(root, 'malformed-utf16.txt'), malformedUtf16)
    const malformed = await readWorkspaceFile(root, 'malformed-utf16.txt')
    expect(malformed.kind).toBe('binary')
    expect(Buffer.from(malformed.content, 'base64')).toEqual(malformedUtf16)

    writeFileSync(
      join(root, 'bom.txt'),
      Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('bom', 'utf8')])
    )
    const bom = await readWorkspaceFile(root, 'bom.txt')
    expect(bom.bom).toBe(true)
    await saveWorkspaceFile({
      workspacePath: root,
      path: 'bom.txt',
      kind: 'text',
      content: 'updated',
      encoding: 'utf8',
      eol: 'none',
      bom: true,
      expectedVersion: bom.version,
      replaceExisting: false
    })
    expect(readFileSync(join(root, 'bom.txt'))[0]).toBe(0xef)

    writeFileSync(join(root, 'image.dat'), Buffer.from([0, 1, 2, 255]))
    const binary = await readWorkspaceFile(root, 'image.dat')
    expect(binary.kind).toBe('binary')
    expect(Buffer.from(binary.content, 'base64')).toEqual(Buffer.from([0, 1, 2, 255]))

    writeFileSync(
      join(root, 'too-large.bin'),
      Buffer.alloc(WORKSPACE_FILE_BINARY_MAX_BYTES + 1, 1)
    )
    await expect(readWorkspaceFile(root, 'too-large.bin')).rejects.toMatchObject({
      code: 'FILE_TOO_LARGE'
    })
  })

  it('rejects stale saves instead of overwriting external changes', async () => {
    const read = await readWorkspaceFile(root, 'src/note.ts')
    writeFileSync(join(root, 'src', 'note.ts'), 'external\r\n', 'utf8')
    await expect(
      saveWorkspaceFile({
        workspacePath: root,
        path: 'src/note.ts',
        kind: 'text',
        content: 'editor\r\n',
        encoding: 'utf8',
        eol: 'crlf',
        bom: false,
        expectedVersion: read.version,
        replaceExisting: false
      })
    ).rejects.toMatchObject({ code: 'FILE_CONFLICT' })
    expect(readFileSync(join(root, 'src', 'note.ts'), 'utf8')).toBe('external\r\n')
  })

  it('serializes same-file saves so one expected version can win', async () => {
    const read = await readWorkspaceFile(root, 'src/note.ts')
    const results = await Promise.allSettled([
      saveWorkspaceFile({
        workspacePath: root,
        path: 'src/note.ts',
        kind: 'text',
        content: 'first',
        encoding: 'utf8',
        eol: 'none',
        bom: false,
        expectedVersion: read.version,
        replaceExisting: false
      }),
      saveWorkspaceFile({
        workspacePath: root,
        path: 'src/note.ts',
        kind: 'text',
        content: 'second',
        encoding: 'utf8',
        eol: 'none',
        bom: false,
        expectedVersion: read.version,
        replaceExisting: false
      })
    ])
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const rejection = results.find((result) => result.status === 'rejected')
    expect(rejection).toMatchObject({ reason: { code: 'FILE_CONFLICT' } })
  })

  it('creates, moves with explicit replacement, and permanently deletes entries', async () => {
    const created = await createWorkspaceFile({
      workspacePath: root,
      parentPath: 'src',
      name: 'new.ts',
      kind: 'file',
      replaceExisting: false
    })
    expect(created.entry.path).toBe('src/new.ts')

    await expect(
      createWorkspaceFile({
        workspacePath: root,
        parentPath: 'src',
        name: 'new.ts',
        kind: 'file',
        replaceExisting: false
      })
    ).rejects.toMatchObject({ code: 'FILE_COLLISION' })

    const moved = await moveWorkspaceFile({
      workspacePath: root,
      fromPath: 'src/new.ts',
      toPath: 'renamed.ts',
      replaceExisting: false
    })
    expect(moved.entry.path).toBe('renamed.ts')

    await expect(
      moveWorkspaceFile({
        workspacePath: root,
        fromPath: 'renamed.ts',
        toPath: 'renamed.ts',
        replaceExisting: true
      })
    ).rejects.toMatchObject({ code: 'PATH_UNSAFE' })

    await deleteWorkspaceFile({
      workspacePath: root,
      path: 'renamed.ts',
      recursive: false
    })
    expect(existsSync(join(root, 'renamed.ts'))).toBe(false)
  })

  it('does not delete a non-empty directory without recursive confirmation', async () => {
    await expect(
      deleteWorkspaceFile({
        workspacePath: root,
        path: 'src',
        recursive: false
      })
    ).rejects.toMatchObject({ code: 'DIRECTORY_NOT_EMPTY' })
  })

  it('rejects workspace-root mutation and unsafe paths', async () => {
    await expect(
      deleteWorkspaceFile({
        workspacePath: root,
        path: '.',
        recursive: true
      })
    ).rejects.toMatchObject({ code: 'WORKSPACE_ROOT' })
    await expect(readWorkspaceFile(root, '../outside.txt')).rejects.toMatchObject({
      code: 'PATH_UNSAFE'
    })
    if (process.platform === 'win32') {
      await expect(
        createWorkspaceFile({
          workspacePath: root,
          parentPath: '',
          name: 'CON',
          kind: 'file',
          replaceExisting: false
        })
      ).rejects.toMatchObject({ code: 'PATH_UNSAFE' })
    }
  })
})

describe('editor recovery persistence', () => {
  it('writes and loads a recovery snapshot, then clears both copies', async () => {
    const snapshot: WorkspaceEditorRecoverySnapshot = {
      version: 1,
      activeTabId: 'tab-1',
      selectedPath: 'src/note.ts',
      expandedPaths: ['', 'src'],
      treeSort: 'kind',
      wordWrap: true,
      savedAt: new Date().toISOString(),
      tabs: [
        {
          id: 'tab-1',
          path: 'src/note.ts',
          kind: 'text',
          content: 'draft',
          encoding: 'utf8',
          eol: 'crlf',
          bom: false,
          version: null,
          dirty: true,
          cursor: 5,
          selections: [{ from: 5, to: 5 }],
          bookmarks: [],
          template: null
        }
      ]
    }
    const session = await loadEditorRecovery(root)
    await saveEditorRecovery(root, snapshot, session.sessionToken, 1)
    await saveEditorRecovery(
      root,
      {
        ...snapshot,
        savedAt: new Date(Date.now() + 1_000).toISOString(),
        tabs: [{ ...snapshot.tabs[0]!, content: 'newer' }]
      },
      session.sessionToken,
      3
    )
    await saveEditorRecovery(root, snapshot, session.sessionToken, 2)
    const loaded = await loadEditorRecovery(root)
    expect(loaded.snapshot?.tabs[0]?.content).toBe('newer')
    expect(loaded.snapshot).toMatchObject({
      selectedPath: 'src/note.ts',
      expandedPaths: ['', 'src'],
      treeSort: 'kind',
      wordWrap: true
    })
    expect(['app', 'project']).toContain(loaded.source)

    await expect(
      saveEditorRecovery(
        root,
        {
          ...snapshot,
          tabs: [{ ...snapshot.tabs[0]!, path: '../outside.txt' }]
        },
        loaded.sessionToken,
        5
      )
    ).rejects.toThrow(/safe workspace-relative path/i)

    await clearEditorRecovery(root, loaded.sessionToken, 4)
    expect((await loadEditorRecovery(root)).snapshot).toBeNull()
  })

  it('scopes recovery generations to the loaded renderer session', async () => {
    const snapshot: WorkspaceEditorRecoverySnapshot = {
      version: 1,
      activeTabId: null,
      savedAt: new Date().toISOString(),
      tabs: []
    }
    const first = await loadEditorRecovery(root)
    await saveEditorRecovery(root, snapshot, first.sessionToken, 1)
    const second = await loadEditorRecovery(root)
    await expect(saveEditorRecovery(root, snapshot, first.sessionToken, 2)).rejects.toMatchObject({
      code: 'RECOVERY'
    })
    await clearEditorRecovery(root, second.sessionToken, 2)
    mkdirSync(join(root, '.vyotiq'), { recursive: true })
    writeFileSync(join(root, '.vyotiq', 'editor-recovery.json'), JSON.stringify(snapshot))
    expect((await loadEditorRecovery(root)).snapshot).toBeNull()
  })

  it('rejects recovery content whose aggregate exceeds the bounded payload', async () => {
    const session = await loadEditorRecovery(root)
    const content = 'x'.repeat(
      Math.floor(WORKSPACE_EDITOR_RECOVERY_MAX_CONTENT_BYTES / 4) + 1
    )
    const snapshot: WorkspaceEditorRecoverySnapshot = {
      version: 1,
      activeTabId: 'tab-0',
      savedAt: new Date().toISOString(),
      tabs: Array.from({ length: 4 }, (_, index) => ({
        id: `tab-${index}`,
        path: `tab-${index}.txt`,
        kind: 'text' as const,
        content,
        encoding: 'utf8' as const,
        eol: 'none' as const,
        bom: false,
        version: null,
        dirty: true,
        cursor: 0,
        selections: [],
        bookmarks: [],
        template: null
      }))
    }
    await expect(
      saveEditorRecovery(root, snapshot, session.sessionToken, 1)
    ).rejects.toMatchObject({ code: 'RECOVERY' })
  })

  it('reads attachment bytes through the bound-handle path', async () => {
    writeFileSync(join(root, 'clip.txt'), 'attach-me', 'utf8')
    const bytes = await readWorkspaceAttachmentBytes(root, 'clip.txt', MAX_ATTACHMENT_BYTES)
    expect(bytes.toString('utf8')).toBe('attach-me')
    await expect(readWorkspaceAttachmentBytes(root, 'src', MAX_ATTACHMENT_BYTES)).rejects.toMatchObject({
      code: 'FILE_NOT_REGULAR'
    })
  })
})
