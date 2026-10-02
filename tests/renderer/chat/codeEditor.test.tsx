/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, renderHook, waitFor } from '@testing-library/react'
import { CompletionContext, type CompletionResult } from '@codemirror/autocomplete'
import { EditorState } from '@codemirror/state'
import { TextCodeEditor } from '@renderer/features/chat/components/TextCodeEditor'
import {
  BUNDLED_EDITOR_LANGUAGES,
  editorLanguageFor,
  hasEditorLanguageGrammar,
  loadLegacyEditorLanguage,
  type EditorLanguageId
} from '@renderer/features/chat/components/editor/editorLanguages'
import {
  collectDocumentWords,
  editorCompletionSource
} from '@renderer/features/chat/components/editor/editorCompletion'
import {
  isCodeEditorTarget,
  isEditableShortcutTarget,
  matchShortcut,
  useAppShortcuts
} from '@renderer/lib/shortcuts'

afterEach(() => {
  cleanup()
  document.body.innerHTML = ''
})

describe('editorLanguageFor', () => {
  const table: Array<[string, EditorLanguageId | null]> = [
    ['src/app.tsx', 'tsx'],
    ['src/app.ts', 'typescript'],
    ['lib/x.mjs', 'javascript'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['main.py', 'python'],
    ['site.scss', 'css'],
    ['index.html', 'html'],
    ['ci.yml', 'yaml'],
    ['cmd/main.go', 'go'],
    ['go.mod', 'go'],
    ['src/lib.rs', 'rust'],
    ['App.java', 'java'],
    ['build.gradle.kts', 'kotlin'],
    ['Main.kt', 'kotlin'],
    ['native/x.c', 'c'],
    ['native/x.h', 'c'],
    ['native/x.cpp', 'cpp'],
    ['native/x.hpp', 'cpp'],
    ['Program.cs', 'csharp'],
    ['View.swift', 'swift'],
    ['scripts/build.sh', 'shell'],
    ['run.zsh', 'shell'],
    ['C:\\Users\\me\\.bashrc', 'shell'],
    ['.zshrc', 'shell'],
    ['setup.ps1', 'powershell'],
    ['schema.sql', 'sql'],
    ['Cargo.toml', 'toml'],
    ['Dockerfile', 'dockerfile'],
    ['docker/Dockerfile.dev', 'dockerfile'],
    ['api.dockerfile', 'dockerfile'],
    ['Gemfile', 'ruby'],
    ['app.rb', 'ruby'],
    ['init.lua', 'lua'],
    ['fix.patch', 'diff'],
    ['change.diff', 'diff'],
    ['setup.cfg', 'properties'],
    ['php.ini', 'properties'],
    ['.env', 'properties'],
    ['.env.local', 'properties'],
    ['CMakeLists.txt', 'cmake'],
    ['App.csproj', 'xml'],
    ['api.proto', 'protobuf'],
    ['Jenkinsfile', 'groovy'],
    // No mode in @codemirror/legacy-modes: plain text.
    ['index.php', null],
    ['Makefile', null],
    ['notes.txt', null],
    ['LICENSE', null],
    ['.gitignore', null]
  ]

  it.each(table)('%s → %s', (path, id) => {
    expect(editorLanguageFor(path)).toBe(id)
  })

  it('has a grammar for every language it can name', () => {
    for (const [, id] of table) {
      if (id) expect(hasEditorLanguageGrammar(id)).toBe(true)
    }
  })

  it('loads a legacy mode on demand and keeps the bundled ones out of the lazy path', async () => {
    expect(BUNDLED_EDITOR_LANGUAGES.has('go')).toBe(false)
    expect(BUNDLED_EDITOR_LANGUAGES.has('typescript')).toBe(true)
    const go = await loadLegacyEditorLanguage('go')
    const state = EditorState.create({ doc: 'package main', extensions: [go] })
    expect(state.facet(EditorState.languageData).length).toBeGreaterThan(0)
    // Cached: the same promise answers the second open.
    expect(loadLegacyEditorLanguage('go')).toBe(loadLegacyEditorLanguage('go'))
  })
})

describe('word completion', () => {
  it('collects distinct words nearest the caret first, leaving out the one being typed', () => {
    const text = 'alpha beta gamma\nbetamax be'
    const words = collectDocumentWords(text, text.length)
    expect(words).toEqual(['betamax', 'gamma', 'beta', 'alpha'])
  })

  it('keeps the word under the caret when it also appears elsewhere, and skips short words and numbers', () => {
    const words = collectDocumentWords('value 123abc ab value', 'value 123abc ab value'.length)
    expect(words).toEqual(['value'])
  })

  it('offers the file’s words for a typed prefix', async () => {
    const doc = 'const handleClick = 1\nhandleSubmit()\nhan'
    const state = EditorState.create({ doc })
    const source = editorCompletionSource(() => null)
    const result = (await source(new CompletionContext(state, doc.length, false))) as CompletionResult
    expect(result.from).toBe(doc.length - 3)
    expect(result.options.map((o) => o.label)).toEqual(expect.arrayContaining(['handleClick', 'handleSubmit']))
  })

  it('waits for two characters before opening on its own', async () => {
    const state = EditorState.create({ doc: 'handle h' })
    const source = editorCompletionSource(() => null)
    expect(await source(new CompletionContext(state, 8, false))).toBeNull()
    expect(await source(new CompletionContext(state, 8, true))).not.toBeNull()
  })

  it('puts language-server items first and drops words it already offered', async () => {
    const doc = 'items.fo\nformat forEach'
    const state = EditorState.create({ doc })
    const fetchLsp = vi.fn(async () => [
      { label: 'forEach', detail: '(cb) => void' },
      { label: 'fooBar', detail: null }
    ])
    const source = editorCompletionSource(() => fetchLsp)
    const result = (await source(new CompletionContext(state, 8, false))) as CompletionResult
    expect(fetchLsp).toHaveBeenCalledWith(0, 8, doc)
    // CodeMirror filters by the typed prefix; the source hands over every word, nearest first.
    expect(result.options.map((o) => o.label)).toEqual(['forEach', 'fooBar', 'format', 'items'])
    expect(result.options[0]!.detail).toBe('(cb) => void')
  })
})

function renderEditor(extra: { readOnly?: boolean } = {}) {
  return render(
    <TextCodeEditor
      path="note.ts"
      value={'const value = 1\nvalue + value\n'}
      cursor={0}
      selections={[{ from: 0, to: 0 }]}
      onChange={vi.fn()}
      onMetaChange={vi.fn()}
      {...extra}
    />
  )
}

function keydown(target: Element, key: string, mods: { ctrlKey?: boolean; shiftKey?: boolean } = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  target.dispatchEvent(event)
  return event
}

describe('find inside the editor', () => {
  it('opens the editor’s own find panel on Ctrl F, and the app’s Find yields', async () => {
    renderEditor()
    const content = document.querySelector('.cm-content')!
    // The guard every window-level Find listener uses (record, Changes, PR).
    const appFind = vi.fn()
    const onKey = (e: KeyboardEvent): void => {
      if (!matchShortcut(e, 'find') || isEditableShortcutTarget(e.target)) return
      appFind()
    }
    window.addEventListener('keydown', onKey)
    try {
      const event = keydown(content, 'f', { ctrlKey: true })
      await waitFor(() => expect(document.querySelector('.cm-search')).not.toBeNull())
      expect(event.defaultPrevented).toBe(true)
      expect(appFind).not.toHaveBeenCalled()
      expect(document.querySelector('.cm-search input[name=replace]')).not.toBeNull()
    } finally {
      window.removeEventListener('keydown', onKey)
    }
  })

  it('treats anything inside a code editor as the editor’s, even when read-only', () => {
    const editor = document.createElement('div')
    editor.className = 'cm-editor'
    const gutter = document.createElement('div')
    editor.appendChild(gutter)
    document.body.appendChild(editor)
    expect(isCodeEditorTarget(gutter)).toBe(true)
    expect(isEditableShortcutTarget(gutter)).toBe(true)
    expect(isCodeEditorTarget(document.body)).toBe(false)
  })

  it('opens at Replace on Ctrl H, and offers no Replace in a read-only file', async () => {
    const view = renderEditor()
    keydown(document.querySelector('.cm-content')!, 'h', { ctrlKey: true })
    await waitFor(() =>
      expect(document.activeElement).toBe(document.querySelector('.cm-search input[name=replace]'))
    )
    view.unmount()

    renderEditor({ readOnly: true })
    keydown(document.querySelector('.cm-content')!, 'f', { ctrlKey: true })
    await waitFor(() => expect(document.querySelector('.cm-search')).not.toBeNull())
    expect(document.querySelector('.cm-search input[name=replace]')).toBeNull()
  })

  it('still lets Ctrl Shift F reach find in files from the editor', () => {
    renderEditor()
    const onFindInFiles = vi.fn()
    const hook = renderHook(() =>
      useAppShortcuts({
        onToggleSidebar: vi.fn(),
        onOpenSearch: vi.fn(),
        onNewChat: vi.fn(),
        onOpenSettings: vi.fn(),
        onFindInFiles
      })
    )
    try {
      keydown(document.querySelector('.cm-content')!, 'F', { ctrlKey: true, shiftKey: true })
      expect(onFindInFiles).toHaveBeenCalledTimes(1)
    } finally {
      hook.unmount()
    }
  })
})
