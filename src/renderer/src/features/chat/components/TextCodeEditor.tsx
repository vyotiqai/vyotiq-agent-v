import { useEffect, useRef } from 'react'
import { minimalSetup } from 'codemirror'
import { bracketMatching, HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { tags as syntaxTags } from '@lezer/highlight'
import { css } from '@codemirror/lang-css'
import { html } from '@codemirror/lang-html'
import { javascript } from '@codemirror/lang-javascript'
import { json } from '@codemirror/lang-json'
import { markdown } from '@codemirror/lang-markdown'
import { python } from '@codemirror/lang-python'
import { yaml } from '@codemirror/lang-yaml'
import { linter, lintGutter, type Diagnostic } from '@codemirror/lint'
import {
  Compartment,
  EditorSelection,
  EditorState,
  RangeSetBuilder,
  Transaction,
  type Extension
} from '@codemirror/state'
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  highlightActiveLine,
  highlightActiveLineGutter,
  hoverTooltip,
  lineNumbers
} from '@codemirror/view'
import type { WorkspaceEditorSelection } from '@shared/ipc'
import {
  mapLspDiagnosticsToCm,
  type LspDiagnosticItem
} from '@shared/utils/lspDiagnostics'
import {
  BUNDLED_EDITOR_LANGUAGES,
  editorLanguageFor,
  loadLegacyEditorLanguage,
  type EditorLanguageId
} from './editor/editorLanguages'
import { editingExtensions, editorSearchExtensions } from './editor/editorSearch'
import type { LspCompletionFetch } from './editor/editorCompletion'

/**
 * The grammar a bundled language builds synchronously; a legacy mode starts as
 * plain text and is swapped in when its chunk lands (see editorLanguages).
 */
function bundledLanguageExtension(id: EditorLanguageId | null): Extension {
  switch (id) {
    case 'tsx':
      return javascript({ jsx: true, typescript: true })
    case 'typescript':
      return javascript({ typescript: true })
    case 'jsx':
      return javascript({ jsx: true })
    case 'javascript':
      return javascript()
    case 'json':
      return json()
    case 'markdown':
      return markdown()
    case 'python':
      return python()
    case 'css':
      return css()
    case 'html':
      return html()
    case 'yaml':
      return yaml()
    default:
      return []
  }
}

/**
 * Syntax palette driven by theme CSS vars (`--vy-syntax-*` in styles.css), so
 * light/dark themes get tuned colors (VS Code Light+/Dark+ style) instead of
 * CodeMirror's light-background default fallback.
 */
const syntaxHighlightStyle = HighlightStyle.define([
  { tag: [syntaxTags.propertyName], color: 'var(--vy-syntax-property)' },
  {
    tag: [syntaxTags.string, syntaxTags.special(syntaxTags.string)],
    color: 'var(--vy-syntax-string)'
  },
  { tag: [syntaxTags.number], color: 'var(--vy-syntax-number)' },
  {
    tag: [
      syntaxTags.bool,
      syntaxTags.null,
      syntaxTags.keyword,
      syntaxTags.controlKeyword,
      syntaxTags.moduleKeyword,
      syntaxTags.operatorKeyword,
      syntaxTags.definitionKeyword,
      syntaxTags.modifier,
      syntaxTags.atom,
      syntaxTags.self,
      syntaxTags.tagName
    ],
    color: 'var(--vy-syntax-keyword)'
  },
  {
    tag: [syntaxTags.lineComment, syntaxTags.blockComment, syntaxTags.docComment],
    color: 'var(--vy-syntax-comment)',
    fontStyle: 'italic'
  },
  {
    tag: [syntaxTags.function(syntaxTags.variableName), syntaxTags.macroName],
    color: 'var(--vy-syntax-func)'
  },
  {
    tag: [syntaxTags.typeName, syntaxTags.className, syntaxTags.namespace],
    color: 'var(--vy-syntax-type)'
  },
  { tag: [syntaxTags.constant(syntaxTags.variableName)], color: 'var(--vy-syntax-constant)' },
  {
    tag: [syntaxTags.variableName, syntaxTags.definition(syntaxTags.variableName)],
    color: 'var(--vy-syntax-variable)'
  },
  { tag: [syntaxTags.attributeName], color: 'var(--vy-syntax-property)' },
  { tag: [syntaxTags.regexp, syntaxTags.escape], color: 'var(--vy-syntax-escape)' },
  { tag: [syntaxTags.meta], color: 'var(--vy-syntax-comment)' },
  { tag: [syntaxTags.heading], color: 'var(--vy-syntax-keyword)', fontWeight: 'bold' },
  { tag: [syntaxTags.strong], fontWeight: 'bold' },
  { tag: [syntaxTags.emphasis], fontStyle: 'italic' },
  { tag: [syntaxTags.link], color: 'var(--vy-syntax-string)', textDecoration: 'underline' },
  { tag: [syntaxTags.invalid], color: 'var(--vy-danger)', textDecoration: 'underline wavy' }
])

function normalizedSelections(
  selections: WorkspaceEditorSelection[],
  length: number
): WorkspaceEditorSelection[] {
  const sorted = selections
    .map((range) => ({
      from: Math.min(Math.max(0, range.from), length),
      to: Math.min(Math.max(range.from, range.to), length)
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to)
  const result: WorkspaceEditorSelection[] = []
  for (const range of sorted) {
    const previous = result[result.length - 1]
    if (previous && range.from < previous.to) {
      previous.to = Math.max(previous.to, range.to)
    } else {
      result.push(range)
    }
  }
  return result
}

/**
 * Gutter marker shapes, drawn as masks and filled with a token — the shape says
 * the severity before the colour does (circle, triangle, square, as the
 * library draws them). The SVGs set no colour: a mask only reads alpha.
 */
const LINT_MARKER_MASK = {
  error: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><circle cx='20' cy='20' r='15'/></svg>")`,
  warning: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><path d='M20 6L37 35L3 35Z'/></svg>")`,
  info: `url("data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><path d='M5 5L35 5L35 35L5 35Z'/></svg>")`
} as const

function lintMarker(mask: string, color: string) {
  return { content: 'normal', backgroundColor: color, maskImage: mask, maskRepeat: 'no-repeat', maskSize: 'contain' }
}

/** A lint range: a wavy underline in the severity's token, not the library's baked-in SVG. */
function lintRange(color: string) {
  return { backgroundImage: 'none', textDecorationColor: color }
}

function lintExtension(getDiagnostics: () => Diagnostic[]): Extension {
  return [linter(() => getDiagnostics()), lintGutter()]
}

function hoverExtension(
  onHover: (line: number, character: number) => Promise<string | null>
): Extension {
  return hoverTooltip(async (view, pos) => {
    const line = view.state.doc.lineAt(pos)
    const content = await onHover(line.number - 1, pos - line.from)
    if (!content) return null
    return {
      pos: line.from,
      end: line.to,
      above: true,
      create() {
        const dom = document.createElement('div')
        // The surface is the themed .cm-tooltip around it (vy-menu tokens).
        dom.className = 'cm-lsp-hover-tooltip px-2.5 py-1.5 text-caption'
        dom.textContent = content
        return { dom }
      }
    }
  })
}

function wrapStyleTheme(enabled: boolean): Extension {
  return EditorView.theme({
    '.cm-scroller': {
      overflowX: enabled ? 'hidden' : 'auto',
      overflowY: 'auto'
    },
    '.cm-content': enabled
      ? {
          wordBreak: 'break-word'
        }
      : {},
    '.cm-line': enabled
      ? {
          overflowWrap: 'anywhere'
        }
      : {}
  })
}

/** `vy-focus-ring`, spelled out: the panel's controls are the library's DOM, not ours to class. */
const FOCUS_RING = { outline: '2px solid var(--vy-focus)', outlineOffset: '2px' }

/** A panel button: CONTROL_HOVER's fill on a ghost control. */
const PANEL_BUTTON = {
  backgroundImage: 'none',
  backgroundColor: 'transparent',
  border: 'none',
  borderRadius: 'var(--vy-radius-sm)',
  height: '24px',
  padding: '0 8px',
  verticalAlign: 'middle',
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-xs)',
  color: 'var(--vy-secondary)',
  cursor: 'pointer',
  '&:hover': { backgroundColor: 'var(--vy-surface)', color: 'var(--vy-fg-strong)' },
  '&:active': { backgroundImage: 'none' },
  '&:focus-visible': FOCUS_RING
}

/**
 * The find panel and the completion list on the app's tokens and type scale:
 * the panel is a flush band under a hairline like a pane row, the list is a
 * vy-menu surface (the `.cm-tooltip` rule) with SELECTED for the active row.
 * Every match is tinted; the current one also gets an outline, so it is not
 * told apart by hue alone.
 */
const SEARCH_AND_COMPLETION_THEME = {
  '.cm-panels': { backgroundColor: 'var(--vy-bg)', color: 'var(--vy-fg)' },
  '.cm-panels.cm-panels-top': { borderBottom: '1px solid var(--vy-border)' },
  '.cm-panel.cm-search': {
    padding: '6px 36px 6px 8px',
    fontFamily: 'var(--font-sans)',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    '& input, & button, & label': { margin: '2px 4px 2px 0' },
    '& label': {
      display: 'inline-flex',
      alignItems: 'center',
      gap: '4px',
      height: '24px',
      padding: '0 4px',
      verticalAlign: 'middle',
      fontSize: 'var(--text-caption)',
      color: 'var(--vy-muted)',
      whiteSpace: 'pre',
      cursor: 'pointer'
    },
    '& input[type=checkbox]': {
      margin: '0',
      accentColor: 'var(--vy-accent)',
      '&:focus-visible': FOCUS_RING
    },
    '& [name=close]': {
      ...PANEL_BUTTON,
      top: '6px',
      right: '6px',
      width: '24px',
      padding: '0',
      margin: '0',
      fontSize: 'var(--text-md)',
      color: 'var(--vy-tertiary)'
    }
  },
  '.cm-textfield': {
    boxSizing: 'border-box',
    height: '24px',
    width: '15rem',
    maxWidth: '100%',
    padding: '0 6px',
    verticalAlign: 'middle',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-xs)',
    color: 'var(--vy-fg)',
    backgroundColor: 'transparent',
    border: '1px solid var(--vy-border)',
    borderRadius: 'var(--vy-radius-sm)',
    '&::placeholder': { color: 'var(--vy-tertiary)' },
    '&:focus-visible': FOCUS_RING
  },
  '.cm-button': PANEL_BUTTON,
  '.cm-searchMatch': { backgroundColor: 'var(--vy-warning-soft)' },
  '.cm-searchMatch.cm-searchMatch-selected': {
    backgroundColor: 'var(--vy-accent-soft)',
    outline: '1px solid var(--vy-accent)'
  },
  '.cm-selectionMatch': { backgroundColor: 'var(--vy-surface-2)' },
  '.cm-searchMatch .cm-selectionMatch': { backgroundColor: 'transparent' },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    padding: '4px',
    '& > ul': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--text-xs)',
      minWidth: '12rem',
      maxHeight: '15rem',
      '& > li': {
        padding: '2px 8px',
        borderRadius: 'var(--vy-radius-md)',
        lineHeight: 'var(--text-xs--line-height)',
        color: 'var(--vy-fg)'
      },
      '& > li:hover': { backgroundColor: 'var(--vy-surface)' }
    }
  },
  '.cm-tooltip-autocomplete ul li[aria-selected]': {
    background: 'var(--vy-surface-2)',
    color: 'var(--vy-fg-strong)'
  },
  '.cm-tooltip-autocomplete-disabled ul li[aria-selected]': { background: 'var(--vy-surface)' },
  '.cm-completionMatchedText': { textDecoration: 'none', color: 'var(--vy-accent)' },
  '.cm-completionDetail': { marginLeft: '12px', fontStyle: 'normal', color: 'var(--vy-tertiary)' }
}

const AGENT_READ_LINE = Decoration.line({ class: 'cm-agentRead' })

/** Tint lines `from`–`to` (1-based, clamped to the file): the lines the task's agent read. */
function markedLinesExtension(range: { from: number; to: number } | null): Extension {
  if (!range) return []
  return [
    EditorView.baseTheme({ '.cm-agentRead': { backgroundColor: 'var(--vy-accent-soft)' } }),
    EditorView.decorations.of((view) => {
      const doc = view.state.doc
      const builder = new RangeSetBuilder<Decoration>()
      const first = Math.max(1, Math.min(range.from, doc.lines))
      const last = Math.max(first, Math.min(range.to, doc.lines))
      // Only what is on screen: a read can span a whole long file.
      for (const visible of view.visibleRanges) {
        const a = Math.max(first, doc.lineAt(visible.from).number)
        const b = Math.min(last, doc.lineAt(visible.to).number)
        for (let n = a; n <= b; n++) {
          const at = doc.line(n).from
          builder.add(at, at, AGENT_READ_LINE)
        }
      }
      return builder.finish()
    })
  ]
}

/** One line the task changed: a 3px bar beside its number, named for anything that reads it. */
class TaskChangeMarker extends GutterMarker {
  override toDOM(): Node {
    const bar = document.createElement('div')
    bar.className = 'cm-taskChange'
    bar.title = 'Changed by this task'
    return bar
  }
}
const TASK_CHANGE = new TaskChangeMarker()

/**
 * The lines the task changed (1-based, as the file reads now), as a bar in a
 * gutter of their own before the numbers — the Changes diff says the same.
 */
function taskChangesExtension(lines: readonly number[] | null): Extension {
  if (!lines?.length) return []
  const changed = new Set(lines)
  return [
    gutter({
      class: 'cm-taskChanges',
      lineMarker: (view, block) => (changed.has(view.state.doc.lineAt(block.from).number) ? TASK_CHANGE : null)
    }),
    EditorView.baseTheme({
      '.cm-taskChanges .cm-gutterElement': { width: '3px', padding: '0' },
      '.cm-taskChange': { width: '3px', height: '100%', backgroundColor: 'var(--vy-success)' }
    })
  ]
}

export function TextCodeEditor({
  path,
  value,
  cursor,
  selections,
  showLineNumbers = true,
  wordWrap = false,
  scrollTop = 0,
  scrollToLine = null,
  markedLines = null,
  changedLines = null,
  lspDiagnostics = null,
  readOnly = false,
  onLspHover,
  onLspComplete,
  onScrollToLineHandled,
  onChange,
  onMetaChange,
  onViewChange
}: {
  path: string
  value: string
  cursor: number
  selections: WorkspaceEditorSelection[]
  showLineNumbers?: boolean
  wordWrap?: boolean
  scrollTop?: number
  scrollToLine?: number | null
  /** Lines to tint — the range the task's agent read of this file. */
  markedLines?: { from: number; to: number } | null
  /** Lines the task changed, as the file reads now: a bar in the gutter beside each. */
  changedLines?: readonly number[] | null
  lspDiagnostics?: readonly LspDiagnosticItem[] | null
  /** No edits: find stays, Replace, completion and bracket closing go. */
  readOnly?: boolean
  onLspHover?: (line: number, character: number) => Promise<string | null>
  /** Language-server completions at a 0-based position; words from the file are offered either way. */
  onLspComplete?: LspCompletionFetch
  onScrollToLineHandled?: () => void
  onChange: (value: string) => boolean | void
  onMetaChange: (meta: { cursor: number; selections: WorkspaceEditorSelection[] }) => void
  onViewChange?: (meta: { scrollTop: number }) => void
}) {
  const hostRef = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  const initialValueRef = useRef(value)
  const initialCursorRef = useRef(cursor)
  const initialSelectionsRef = useRef(selections)
  const syncingRef = useRef(false)
  const localValueRef = useRef(value)
  const onChangeRef = useRef(onChange)
  const onMetaChangeRef = useRef(onMetaChange)
  const onViewChangeRef = useRef(onViewChange)
  const onScrollToLineHandledRef = useRef(onScrollToLineHandled)
  const lineNumbersRef = useRef(showLineNumbers)
  const initialScrollTopRef = useRef(scrollTop)
  const wordWrapRef = useRef(wordWrap)
  const lineNumbersCompartmentRef = useRef(new Compartment())
  const wrapCompartmentRef = useRef(new Compartment())
  const wrapStyleCompartmentRef = useRef(new Compartment())
  const lintCompartmentRef = useRef(new Compartment())
  const markCompartmentRef = useRef(new Compartment())
  const initialMarkedLinesRef = useRef(markedLines)
  const changesCompartmentRef = useRef(new Compartment())
  const initialChangedLinesRef = useRef(changedLines)
  const hoverCompartmentRef = useRef(new Compartment())
  const completeCompartmentRef = useRef(new Compartment())
  const readOnlyCompartmentRef = useRef(new Compartment())
  const languageCompartmentRef = useRef(new Compartment())
  const readOnlyRef = useRef(readOnly)
  const lspDiagnosticsRef = useRef(lspDiagnostics)
  const onLspHoverRef = useRef(onLspHover)
  const onLspCompleteRef = useRef(onLspComplete)
  readOnlyRef.current = readOnly
  onLspCompleteRef.current = onLspComplete
  initialValueRef.current = value
  initialCursorRef.current = cursor
  initialSelectionsRef.current = selections
  onChangeRef.current = onChange
  onMetaChangeRef.current = onMetaChange
  onViewChangeRef.current = onViewChange
  onScrollToLineHandledRef.current = onScrollToLineHandled
  lineNumbersRef.current = showLineNumbers
  initialScrollTopRef.current = scrollTop
  wordWrapRef.current = wordWrap
  lspDiagnosticsRef.current = lspDiagnostics
  onLspHoverRef.current = onLspHover

  useEffect(() => {
    const host = hostRef.current
    if (!host) return undefined

    const languageId = editorLanguageFor(path)
    const lazyLanguage = languageId != null && !BUNDLED_EDITOR_LANGUAGES.has(languageId)
    const doc = initialValueRef.current
    const ranges =normalizedSelections(initialSelectionsRef.current, doc.length).map((range) =>
      EditorSelection.range(
        Math.min(range.from, doc.length),
        Math.min(range.to, doc.length)
      )
    )
    const state = EditorState.create({
      doc,
      selection:
        ranges.length > 0
          ? EditorSelection.create(ranges)
          : EditorSelection.cursor(Math.min(initialCursorRef.current, doc.length)),
      extensions: [
        minimalSetup,
        languageCompartmentRef.current.of(lazyLanguage ? [] : bundledLanguageExtension(languageId)),
        syntaxHighlighting(syntaxHighlightStyle),
        bracketMatching(),
        // Ctrl/Cmd D and Alt-click build several selections; the tab keeps all of them.
        EditorState.allowMultipleSelections.of(true),
        editorSearchExtensions(),
        readOnlyCompartmentRef.current.of(EditorState.readOnly.of(readOnlyRef.current)),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        changesCompartmentRef.current.of(taskChangesExtension(initialChangedLinesRef.current)),
        lineNumbersCompartmentRef.current.of(
          lineNumbersRef.current ? lineNumbers() : []
        ),
        wrapCompartmentRef.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        wrapStyleCompartmentRef.current.of(wrapStyleTheme(wordWrapRef.current)),
        lintCompartmentRef.current.of([]),
        markCompartmentRef.current.of(markedLinesExtension(initialMarkedLinesRef.current)),
        hoverCompartmentRef.current.of([]),
        completeCompartmentRef.current.of(
          editingExtensions(readOnlyRef.current, () => onLspCompleteRef.current)
        ),
        EditorView.theme({
          '&': {
            height: '100%',
            backgroundColor: 'transparent',
            color: 'var(--vy-fg)'
          },
          '.cm-scroller': {
            fontFamily: 'var(--font-mono)',
            lineHeight: '1.6'
          },
          '.cm-content': {
            caretColor: 'var(--vy-accent)',
            padding: '0.375rem 0.5rem'
          },
          '.cm-line': {
            padding: '0 0.125rem'
          },
          '.cm-selectionBackground, ::selection': {
            backgroundColor: 'var(--vy-accent-soft)'
          },
          // The library's focused-selection rule is just as specific; a theme rule comes later and wins.
          '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
            background: 'var(--vy-accent-soft)'
          },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'var(--vy-accent)'
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            borderRight: '1px solid var(--vy-border)',
            color: 'var(--vy-muted)',
            paddingRight: '0.25rem'
          },
          '.cm-lineNumbers .cm-gutterElement': {
            minWidth: '2.25rem',
            padding: '0 0.25rem 0 0.5rem'
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'var(--vy-surface)'
          },
          // The selection layer paints under the lines, so an opaque line fill would hide
          // the selection on the caret's line — and there is no translucent grey token.
          // The gutter cell marks the active line; the class stays for anything reading it.
          '.cm-activeLine': {
            backgroundColor: 'transparent'
          },
          '.cm-matchingBracket': {
            backgroundColor: 'var(--vy-accent-soft)',
            outline: '1px solid var(--vy-accent)',
            color: 'inherit'
          },
          '.cm-lintRange': {
            backgroundImage: 'none',
            paddingBottom: '0',
            textDecorationLine: 'underline',
            textDecorationStyle: 'wavy',
            textDecorationSkipInk: 'none',
            textUnderlineOffset: '2px'
          },
          '.cm-lintRange-error': lintRange('var(--vy-danger)'),
          '.cm-lintRange-warning': lintRange('var(--vy-warning)'),
          '.cm-lintRange-info': lintRange('var(--vy-tertiary)'),
          '.cm-lintRange-hint': lintRange('var(--vy-tertiary)'),
          '.cm-lintRange-active': { backgroundColor: 'var(--vy-warning-soft)' },
          '.cm-lintPoint:after': { borderBottomColor: 'var(--vy-danger)' },
          '.cm-lintPoint-warning:after': { borderBottomColor: 'var(--vy-warning)' },
          '.cm-lintPoint-info:after, .cm-lintPoint-hint:after': { borderBottomColor: 'var(--vy-tertiary)' },
          '.cm-lint-marker-error': lintMarker(LINT_MARKER_MASK.error, 'var(--vy-danger)'),
          '.cm-lint-marker-warning': lintMarker(LINT_MARKER_MASK.warning, 'var(--vy-warning)'),
          '.cm-lint-marker-info': lintMarker(LINT_MARKER_MASK.info, 'var(--vy-tertiary)'),
          // Hover and lint tooltips on the vy-menu surface: page colour, menu radius and elevation.
          '.cm-tooltip': {
            backgroundColor: 'var(--vy-bg)',
            color: 'var(--vy-fg)',
            border: 'none',
            borderRadius: 'var(--vy-radius-xl)',
            boxShadow: 'var(--vy-shadow-menu)',
            overflow: 'hidden'
          },
          '.cm-tooltip-section:not(:first-child)': {
            borderTop: '1px solid var(--vy-border)'
          },
          '.cm-diagnostic-error': { borderLeftColor: 'var(--vy-danger)' },
          '.cm-diagnostic-warning': { borderLeftColor: 'var(--vy-warning)' },
          '.cm-diagnostic-info, .cm-diagnostic-hint': { borderLeftColor: 'var(--vy-tertiary)' },
          '.cm-lsp-hover-tooltip': {
            maxWidth: '28rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--vy-fg)'
          },
          ...SEARCH_AND_COMPLETION_THEME
        }),
        EditorView.updateListener.of((update) => {
          const isReload = update.transactions.some(
            (transaction) =>
              transaction.annotation(Transaction.userEvent) === 'input.reload'
          )
          let accepted = true
          if (update.docChanged && !syncingRef.current && !isReload) {
            const next = update.state.doc.toString()
            accepted = onChangeRef.current(next) !== false
            if (accepted) {
              localValueRef.current = next
            } else {
              const previous = localValueRef.current
              const rejectedView = viewRef.current
              queueMicrotask(() => {
                const currentView = viewRef.current
                if (
                  !rejectedView ||
                  currentView !== rejectedView ||
                  currentView.state.doc.toString() === previous
                ) {
                  return
                }
                syncingRef.current = true
                try {
                  currentView.dispatch({
                    changes: {
                      from: 0,
                      to: currentView.state.doc.length,
                      insert: previous
                    },
                    annotations: Transaction.userEvent.of('input.reload')
                  })
                } finally {
                  syncingRef.current = false
                }
              })
            }
          }
          if (accepted && (update.selectionSet || update.docChanged)) {
            onMetaChangeRef.current({
              cursor: update.state.selection.main.head,
              selections: update.state.selection.ranges.map((range) => ({
                from: range.from,
                to: range.to
              }))
            })
          }
        })
      ]
    })
    const view = new EditorView({ state, parent: host })
    viewRef.current = view
    if (lazyLanguage) {
      // Plain text until the mode's chunk lands; a closed or reopened editor ignores a late one.
      void loadLegacyEditorLanguage(languageId).then((extension) => {
        if (viewRef.current !== view) return
        view.dispatch({ effects: languageCompartmentRef.current.reconfigure(extension) })
      })
    }
    const scroller = view.scrollDOM
    scroller.scrollTop = Math.max(0, initialScrollTopRef.current)
    const onScroll = (): void => {
      onViewChangeRef.current?.({ scrollTop: Math.max(0, scroller.scrollTop) })
    }
    scroller.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      scroller.removeEventListener('scroll', onScroll)
      view.destroy()
      viewRef.current = null
    }
  }, [path])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: lineNumbersCompartmentRef.current.reconfigure(
        showLineNumbers ? lineNumbers() : []
      )
    })
  }, [showLineNumbers])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        wrapCompartmentRef.current.reconfigure(wordWrap ? EditorView.lineWrapping : []),
        wrapStyleCompartmentRef.current.reconfigure(wrapStyleTheme(wordWrap))
      ]
    })
  }, [wordWrap])

  useEffect(() => {
    const view = viewRef.current
    if (!view || view.state.readOnly === readOnly) return
    view.dispatch({
      effects: [
        readOnlyCompartmentRef.current.reconfigure(EditorState.readOnly.of(readOnly)),
        completeCompartmentRef.current.reconfigure(
          editingExtensions(readOnly, () => onLspCompleteRef.current)
        )
      ]
    })
  }, [readOnly])

  const markFrom = markedLines?.from ?? null
  const markTo = markedLines?.to ?? null
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: markCompartmentRef.current.reconfigure(
        markFrom != null && markTo != null ? markedLinesExtension({ from: markFrom, to: markTo }) : []
      )
    })
  }, [markFrom, markTo])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({ effects: changesCompartmentRef.current.reconfigure(taskChangesExtension(changedLines)) })
  }, [changedLines])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const items = lspDiagnostics ?? []
    view.dispatch({
      effects: lintCompartmentRef.current.reconfigure(
        items.length > 0
          ? lintExtension(() => {
              const current = viewRef.current
              if (!current) return []
              return mapLspDiagnosticsToCm(
                current.state.doc.toString(),
                lspDiagnosticsRef.current ?? []
              )
            })
          : []
      )
    })
  }, [lspDiagnostics])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const hover = onLspHover
    view.dispatch({
      effects: hoverCompartmentRef.current.reconfigure(
        hover
          ? hoverExtension((line, character) => {
              const fn = onLspHoverRef.current
              return fn ? fn(line, character) : Promise.resolve(null)
            })
          : []
      )
    })
  }, [onLspHover])

  useEffect(() => {
    const view = viewRef.current
    if (!view || localValueRef.current === value) return
    syncingRef.current = true
    try {
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: value },
        annotations: Transaction.userEvent.of('input.reload')
      })
      localValueRef.current = value
    } finally {
      syncingRef.current = false
    }
  }, [value])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const nextRanges = normalizedSelections(selections, view.state.doc.length).map((range) =>
      EditorSelection.range(
        Math.min(range.from, view.state.doc.length),
        Math.min(range.to, view.state.doc.length)
      )
    )
    const nextSelection =
      nextRanges.length > 0
        ? EditorSelection.create(nextRanges)
        : EditorSelection.create([EditorSelection.cursor(Math.min(cursor, view.state.doc.length))])
    const currentRanges = view.state.selection.ranges
    const sameRanges =
      currentRanges.length === nextSelection.ranges.length &&
      currentRanges.every(
        (range, index) =>
          range.from === nextSelection.ranges[index]?.from &&
          range.to === nextSelection.ranges[index]?.to
      )
    if (sameRanges) return
    view.dispatch({
      selection: nextSelection
    })
  }, [cursor, selections])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const next = Math.max(0, scrollTop)
    if (Math.abs(view.scrollDOM.scrollTop - next) > 1) {
      view.scrollDOM.scrollTop = next
    }
  }, [scrollTop])

  useEffect(() => {
    const view = viewRef.current
    if (!view || scrollToLine == null || scrollToLine < 1) return
    const lineNo = Math.min(scrollToLine, view.state.doc.lines)
    const line = view.state.doc.line(lineNo)
    view.dispatch({
      selection: EditorSelection.cursor(line.from),
      effects: EditorView.scrollIntoView(line.from, { y: 'center' })
    })
    onMetaChangeRef.current({
      cursor: line.from,
      selections: [{ from: line.from, to: line.from }]
    })
    onScrollToLineHandledRef.current?.()
  }, [scrollToLine])

  return (
    <div
      ref={hostRef}
      role="region"
      aria-label={`Editor for ${path}`}
      className="min-h-0 min-w-0 w-full max-w-full flex-1 overflow-hidden"
      data-code-editor
      data-word-wrap={wordWrap ? 'true' : 'false'}
    />
  )
}
