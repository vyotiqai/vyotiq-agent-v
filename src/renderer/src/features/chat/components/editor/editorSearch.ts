import { autocompletion, closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { indentOnInput } from '@codemirror/language'
import {
  highlightSelectionMatches,
  openSearchPanel,
  search,
  searchKeymap
} from '@codemirror/search'
import { EditorState, Prec, type Extension } from '@codemirror/state'
import { keymap, type Command } from '@codemirror/view'
import { editorCompletionSource, type LspCompletionFetch } from './editorCompletion'

/**
 * Open the find panel with the caret in its Replace field. A read-only file's
 * panel has no Replace field, so it lands in Find instead.
 */
export const openReplacePanel: Command = (view) => {
  openSearchPanel(view)
  if (view.state.readOnly) return true
  const field = view.dom.querySelector<HTMLInputElement>('.cm-search input[name=replace]')
  if (field) {
    field.focus()
    field.select()
  }
  return true
}

/** The panel's words, capitalised the way the app writes a control. */
const SEARCH_PHRASES = {
  Find: 'Find',
  Replace: 'Replace',
  next: 'Next',
  previous: 'Previous',
  all: 'All',
  'match case': 'Match case',
  regexp: 'Regex',
  'by word': 'Whole word',
  replace: 'Replace',
  'replace all': 'Replace all',
  close: 'Close find'
}

/**
 * Find and replace inside the file: Ctrl/Cmd F opens the panel, Ctrl H (and
 * Ctrl/Cmd Alt F, since Cmd H hides the app on macOS) opens it at Replace,
 * Enter / Shift Enter / F3 / Shift F3 step through matches, Ctrl/Cmd D adds the
 * next occurrence to the selection, and every copy of the selected word is
 * marked. Above the default keymap so these keys reach the panel first.
 */
export function editorSearchExtensions(): Extension {
  return [
    search({ top: true }),
    highlightSelectionMatches(),
    EditorState.phrases.of(SEARCH_PHRASES),
    Prec.high(
      keymap.of([
        ...searchKeymap,
        { key: 'Mod-h', run: openReplacePanel, scope: 'editor search-panel', preventDefault: true },
        { key: 'Mod-Alt-f', run: openReplacePanel, scope: 'editor search-panel', preventDefault: true }
      ])
    )
  ]
}

/**
 * What only makes sense where the file can change: completion, closing
 * brackets and re-indenting as you type. Empty for a read-only file.
 */
export function editingExtensions(
  readOnly: boolean,
  getFetchLsp: () => LspCompletionFetch | null | undefined
): Extension {
  if (readOnly) return []
  const source = editorCompletionSource(getFetchLsp)
  return [
    closeBrackets(),
    indentOnInput(),
    autocompletion({ icons: false, activateOnTypingDelay: 120 }),
    // Beside the language's own sources (JS locals, CSS properties), not instead of them.
    EditorState.languageData.of(() => [{ autocomplete: source }]),
    Prec.high(keymap.of(closeBracketsKeymap))
  ]
}
