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
  Transaction,
  type Extension
} from '@codemirror/state'
import { EditorView, highlightActiveLine, highlightActiveLineGutter, hoverTooltip, lineNumbers } from '@codemirror/view'
import type { WorkspaceEditorSelection } from '@shared/ipc'
import {
  mapLspDiagnosticsToCm,
  type LspDiagnosticItem
} from '@shared/utils/lspDiagnostics'

function languageExtension(path: string): Extension {
  const lower = path.toLowerCase()
  if (lower.endsWith('.tsx')) return javascript({ jsx: true, typescript: true })
  if (lower.endsWith('.ts')) return javascript({ typescript: true })
  if (lower.endsWith('.jsx')) return javascript({ jsx: true })
  if (/\.(js|mjs|cjs)$/.test(lower)) return javascript()
  if (lower.endsWith('.json')) return json()
  if (/\.(md|mdc)$/.test(lower)) return markdown()
  if (lower.endsWith('.py')) return python()
  if (/\.(css|scss)$/.test(lower)) return css()
  if (/\.(html|htm|vue)$/.test(lower)) return html()
  if (/\.(yaml|yml)$/.test(lower)) return yaml()
  return []
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
        dom.className = 'cm-lsp-hover-tooltip px-2 py-1 text-caption'
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

export function TextCodeEditor({
  path,
  value,
  cursor,
  selections,
  showLineNumbers = true,
  wordWrap = false,
  scrollTop = 0,
  scrollToLine = null,
  lspDiagnostics = null,
  onLspHover,
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
  lspDiagnostics?: readonly LspDiagnosticItem[] | null
  onLspHover?: (line: number, character: number) => Promise<string | null>
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
  const hoverCompartmentRef = useRef(new Compartment())
  const completeCompartmentRef = useRef(new Compartment())
  const lspDiagnosticsRef = useRef(lspDiagnostics)
  const onLspHoverRef = useRef(onLspHover)
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

    const doc = initialValueRef.current
    const ranges = normalizedSelections(initialSelectionsRef.current, doc.length).map((range) =>
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
        languageExtension(path),
        syntaxHighlighting(syntaxHighlightStyle),
        bracketMatching(),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        lineNumbersCompartmentRef.current.of(
          lineNumbersRef.current ? lineNumbers() : []
        ),
        wrapCompartmentRef.current.of(wordWrapRef.current ? EditorView.lineWrapping : []),
        wrapStyleCompartmentRef.current.of(wrapStyleTheme(wordWrapRef.current)),
        lintCompartmentRef.current.of([]),
        hoverCompartmentRef.current.of([]),
        completeCompartmentRef.current.of([]),
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
            backgroundColor: 'color-mix(in srgb, var(--vy-accent) 24%, transparent)'
          },
          '.cm-cursor, .cm-dropCursor': {
            borderLeftColor: 'var(--vy-accent)'
          },
          '.cm-gutters': {
            backgroundColor: 'transparent',
            borderRight: '1px solid color-mix(in srgb, var(--vy-border) 60%, transparent)',
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
          '.cm-activeLine': {
            backgroundColor: 'color-mix(in srgb, var(--vy-surface) 45%, transparent)'
          },
          '.cm-matchingBracket': {
            backgroundColor: 'color-mix(in srgb, var(--vy-accent) 14%, transparent)',
            outline: '1px solid color-mix(in srgb, var(--vy-accent) 35%, transparent)',
            color: 'inherit'
          },
          '.cm-lintRange-error': {
            backgroundImage:
              "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2' fill='none' stroke='%23ef4444' stroke-width='1'/></svg>\")"
          },
          '.cm-lintRange-warning': {
            backgroundImage:
              "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2' fill='none' stroke='%23f59e0b' stroke-width='1'/></svg>\")"
          },
          '.cm-lintRange-info': {
            backgroundImage:
              "url(\"data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' width='6' height='3'><path d='m0 3 l2 -2 l1 0 l2 2' fill='none' stroke='%236b7280' stroke-width='1'/></svg>\")"
          },
          '.cm-lsp-hover-tooltip': {
            maxWidth: '28rem',
            whiteSpace: 'pre-wrap',
            color: 'var(--vy-fg)',
            backgroundColor: 'var(--vy-surface)',
            border: '1px solid color-mix(in srgb, var(--vy-border) 70%, transparent)',
            borderRadius: '0.375rem'
          }
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
