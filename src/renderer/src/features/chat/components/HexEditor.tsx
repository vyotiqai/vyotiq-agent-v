import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent
} from 'react'
import { useAppVirtualizer } from '@renderer/lib/hooks/useAppVirtualizer'
import {
  WORKSPACE_FILE_BINARY_MAX_BYTES,
  type WorkspaceEditorSelection
} from '@shared/ipc'
import { Icon } from '@renderer/lib/icons'
import { DOCK_TOOLBAR_BTN, DOCK_TOOLBAR_ICON_BTN } from './PanelChrome'
import { usePrompt } from '@renderer/lib/hooks/usePrompt'

const BYTES_PER_ROW = 16
const MAX_HISTORY = 100
const MAX_TEMPLATE_FIELD_LENGTH = 4096
const MAX_HISTORY_BYTES = 64 * 1024 * 1024
const MAX_HEX_PATTERN_BYTES = 4096

function decodeBase64(value: string): Uint8Array {
  if (!value) return new Uint8Array()
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunkSize = 0x8000
  for (let index = 0; index < bytes.length; index += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunkSize))
  }
  return btoa(binary)
}

function parseHexPattern(raw: string, allowEmpty = false): Uint8Array | null {
  if (raw.length > MAX_HEX_PATTERN_BYTES * 3) return null
  const tokens = raw
    .trim()
    .replace(/0x/gi, '')
    .split(/[\s,:-]+/)
    .filter(Boolean)
  if (!allowEmpty && tokens.length === 0) return null
  if (tokens.length > MAX_HEX_PATTERN_BYTES || tokens.some((token) => !/^[0-9a-f]{1,2}$/i.test(token))) {
    return null
  }
  const values = tokens.map((token) => Number.parseInt(token, 16))
  if (
    values.some((value) => !Number.isInteger(value) || value < 0 || value > 255)
  ) {
    return null
  }
  return Uint8Array.from(values)
}

function trimHistory(items: string[]): string[] {
  let total = 0
  const kept: string[] = []
  for (let index = items.length - 1; index >= 0 && kept.length < MAX_HISTORY; index--) {
    const item = items[index]!
    const bytes = Math.ceil(item.length * 0.75)
    if (total + bytes > MAX_HISTORY_BYTES) break
    kept.unshift(item)
    total += bytes
  }
  return kept
}

function replaceBytes(
  bytes: Uint8Array,
  search: Uint8Array,
  replacement: Uint8Array
): Uint8Array | null {
  if (search.length === 0) return bytes
  const prefix = new Uint32Array(search.length)
  for (let index = 1, length = 0; index < search.length; index++) {
    while (length > 0 && search[index] !== search[length]) {
      length = prefix[length - 1] ?? 0
    }
    if (search[index] === search[length]) length++
    prefix[index] = length
  }
  const forEachMatch = (visit: (index: number) => void): void => {
    let matched = 0
    for (let index = 0; index < bytes.length; index++) {
      while (matched > 0 && bytes[index] !== search[matched]) {
        matched = prefix[matched - 1] ?? 0
      }
      if (bytes[index] === search[matched]) matched++
      if (matched === search.length) {
        visit(index - search.length + 1)
        matched = 0
      }
    }
  }
  let matches = 0
  forEachMatch(() => {
    matches++
  })
  const outputLength = bytes.length + matches * (replacement.length - search.length)
  if (outputLength > WORKSPACE_FILE_BINARY_MAX_BYTES) return null
  const output = new Uint8Array(outputLength)
  let source = 0
  let cursor = 0
  forEachMatch((index) => {
    output.set(bytes.subarray(source, index), cursor)
    cursor += index - source
    output.set(replacement, cursor)
    cursor += replacement.length
    source = index + search.length
  })
  output.set(bytes.subarray(source), cursor)
  return output
}

function printable(byte: number): string {
  return byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.'
}

function byteText(byte: number): string {
  return byte.toString(16).padStart(2, '0').toUpperCase()
}

type TemplateField = {
  name: string
  kind: 'u8' | 'u16le' | 'u32le' | 'ascii'
  offset: number
  length: number
}

function parseTemplate(raw: string | null): TemplateField[] {
  if (!raw?.trim()) return []
  return raw
    .split(',')
    .map((part) => {
      const match = /^([^:,\s]+):(u8|u16le|u32le|ascii)@(\d+)(?::(\d+))?$/i.exec(part.trim())
      if (!match) return null
      const kind = match[2]!.toLowerCase() as TemplateField['kind']
      const defaultLength = kind === 'ascii' ? 1 : kind === 'u32le' ? 4 : kind === 'u16le' ? 2 : 1
      const offset = Number(match[3])
      const length = Number(match[4] ?? defaultLength)
      if (
        !Number.isSafeInteger(offset) ||
        !Number.isSafeInteger(length) ||
        offset < 0 ||
        length < 1 ||
        length > MAX_TEMPLATE_FIELD_LENGTH
      ) {
        return null
      }
      return {
        name: match[1]!,
        kind,
        offset,
        length
      }
    })
    .filter((field): field is TemplateField => field != null)
}

function templateValue(bytes: Uint8Array, field: TemplateField): string {
  if (field.offset < 0 || field.offset + field.length > bytes.length) return 'out of range'
  if (field.kind === 'ascii') {
    return String.fromCharCode(...bytes.slice(field.offset, field.offset + field.length)).replace(
      /[^\x20-\x7e]/g,
      '.'
    )
  }
  let value = 0
  for (let index = field.length - 1; index >= 0; index--) {
    value = value * 256 + (bytes[field.offset + index] ?? 0)
  }
  return `0x${value.toString(16).toUpperCase()} (${value})`
}

function clampSelections(
  selections: WorkspaceEditorSelection[],
  length: number
): WorkspaceEditorSelection[] {
  return selections
    .map((selection) => ({
      from: Math.min(selection.from, length),
      to: Math.min(Math.max(selection.to, selection.from), length)
    }))
    .filter((selection) => selection.from < selection.to || length === 0)
}

export function HexEditor({
  value,
  cursor,
  bookmarks,
  selections: initialSelections,
  template,
  scrollTop = 0,
  onChange,
  onMetaChange,
  onViewChange
}: {
  value: string
  cursor?: number
  bookmarks: number[]
  selections: WorkspaceEditorSelection[]
  template: string | null
  scrollTop?: number
  onChange: (value: string) => boolean | void
  onMetaChange: (meta: {
    cursor: number
    selections: WorkspaceEditorSelection[]
    bookmarks: number[]
    template: string | null
  }) => void
  onViewChange?: (meta: { scrollTop: number }) => void
}) {
  const resolvedCursor = cursor ?? 0
  const [bytes, setBytes] = useState(() => decodeBase64(value))
  const [selected, setSelected] = useState(() => resolvedCursor)
  const [selectedColumn, setSelectedColumn] = useState<'hex' | 'ascii'>('hex')
  const [selections, setSelections] = useState<WorkspaceEditorSelection[]>(initialSelections)
  const [activeBookmarks, setActiveBookmarks] = useState<number[]>(bookmarks)
  const [activeTemplate, setActiveTemplate] = useState<string | null>(template)
  const [past, setPast] = useState<string[]>([])
  const [future, setFuture] = useState<string[]>([])
  const [validationError, setValidationError] = useState<string | null>(null)
  const encodedRef = useRef(value)
  const scrollRef = useRef<HTMLDivElement>(null)
  const onViewChangeRef = useRef(onViewChange)
  const initialScrollTopRef = useRef(scrollTop)
  const { prompt: requestPrompt, dialog: promptDialog } = usePrompt()
  onViewChangeRef.current = onViewChange
  initialScrollTopRef.current = scrollTop

  useEffect(() => {
    if (value === encodedRef.current) return
    encodedRef.current = value
    const next = decodeBase64(value)
    setBytes(next)
    setSelected((previous) => Math.min(previous, Math.max(0, next.length - 1)))
    setSelections((previous) => clampSelections(previous, next.length))
    setActiveBookmarks((previous) =>
      previous.filter((bookmark) => bookmark < next.length)
    )
    setPast([])
    setFuture([])
  }, [value])

  useEffect(() => {
    setSelections(clampSelections(initialSelections, bytes.length))
  }, [bytes.length, initialSelections])

  useEffect(() => {
    setActiveBookmarks(bookmarks.filter((bookmark) => bookmark < bytes.length))
  }, [bookmarks, bytes.length])

  useEffect(() => {
    setActiveTemplate(template)
  }, [template])

  useEffect(() => {
    setSelected(Math.min(resolvedCursor, Math.max(0, bytes.length - 1)))
  }, [bytes.length, resolvedCursor])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return undefined
    element.scrollTop = Math.max(0, initialScrollTopRef.current)
    const onScroll = (): void => {
      onViewChangeRef.current?.({ scrollTop: Math.max(0, element.scrollTop) })
    }
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => element.removeEventListener('scroll', onScroll)
  }, [])

  useEffect(() => {
    const element = scrollRef.current
    if (!element) return
    const next = Math.max(0, scrollTop)
    if (Math.abs(element.scrollTop - next) > 1) element.scrollTop = next
  }, [scrollTop])

  const emitMeta = useCallback(
    (
      cursor: number,
      nextSelections: WorkspaceEditorSelection[],
      nextBookmarks: number[],
      nextTemplate: string | null
    ): void => {
      onMetaChange({
        cursor,
        selections: nextSelections,
        bookmarks: nextBookmarks,
        template: nextTemplate
      })
    },
    [onMetaChange]
  )

  const commit = useCallback(
    (next: Uint8Array, nextSelected = selected): void => {
      if (next.byteLength > WORKSPACE_FILE_BINARY_MAX_BYTES) return
      const current = encodedRef.current
      const encoded = encodeBase64(next)
      if (onChange(encoded) === false) return
      const boundedSelected = Math.min(
        Math.max(0, nextSelected),
        Math.max(0, next.length - 1)
      )
      const boundedSelections = clampSelections(selections, next.length)
      const boundedBookmarks = activeBookmarks.filter(
        (bookmark) => bookmark >= 0 && bookmark < next.length
      )
      setPast((previous) => trimHistory([...previous, current]))
      setFuture([])
      encodedRef.current = encoded
      setBytes(next)
      setSelected(boundedSelected)
      setSelections(boundedSelections)
      setActiveBookmarks(boundedBookmarks)
      emitMeta(boundedSelected, boundedSelections, boundedBookmarks, activeTemplate)
    },
    [activeBookmarks, activeTemplate, emitMeta, onChange, selected, selections]
  )

  const undo = useCallback((): void => {
    const previous = past[past.length - 1]
    if (previous === undefined) return
    const current = encodedRef.current
    if (onChange(previous) === false) return
    setPast((items) => items.slice(0, -1))
    setFuture((items) => trimHistory([current, ...items]))
    encodedRef.current = previous
    setBytes(decodeBase64(previous))
  }, [onChange, past])

  const redo = useCallback((): void => {
    const next = future[0]
    if (next === undefined) return
    const current = encodedRef.current
    if (onChange(next) === false) return
    setFuture((items) => items.slice(1))
    setPast((items) => trimHistory([...items, current]))
    encodedRef.current = next
    setBytes(decodeBase64(next))
  }, [future, onChange])

  const selectByte = useCallback(
    (
      index: number,
      extend: boolean,
      multi: boolean,
      column: 'hex' | 'ascii'
    ): void => {
      const bounded = Math.max(0, Math.min(index, Math.max(0, bytes.length - 1)))
      setSelected(bounded)
      setSelectedColumn(column)
      const nextSelections = multi
        ? selections.some((range) => bounded >= range.from && bounded < range.to)
          ? selections.filter((range) => !(bounded >= range.from && bounded < range.to))
          : [...selections, { from: bounded, to: bounded + 1 }]
        : extend
          ? [
              {
                from: Math.min(selected, bounded),
                to: Math.max(selected, bounded) + 1
              }
            ]
          : [{ from: bounded, to: bounded + 1 }]
      setSelections(nextSelections)
      emitMeta(bounded, nextSelections, activeBookmarks, activeTemplate)
    },
    [activeBookmarks, activeTemplate, bytes.length, emitMeta, selected, selections]
  )

  const handleByteKeyDown = useCallback(
    (
      event: ReactKeyboardEvent<HTMLInputElement>,
      index: number,
      column: 'hex' | 'ascii'
    ): void => {
      if (event.key === 'Tab') {
        event.preventDefault()
        const nextColumn = event.shiftKey
          ? column === 'ascii'
            ? 'hex'
            : 'ascii'
          : column === 'hex'
            ? 'ascii'
            : 'hex'
        const nextIndex = event.shiftKey
          ? column === 'hex'
            ? Math.max(0, index - 1)
            : index
          : column === 'hex'
            ? index
            : Math.min(Math.max(0, bytes.length - 1), index + 1)
        selectByte(nextIndex, false, false, nextColumn)
        document
          .querySelector<HTMLInputElement>(
            `[data-hex-byte="${nextIndex}"][data-hex-column="${nextColumn}"]`
          )
          ?.focus()
        return
      }
      const delta =
        event.key === 'ArrowLeft'
          ? -1
          : event.key === 'ArrowRight'
            ? 1
            : event.key === 'ArrowUp'
              ? -BYTES_PER_ROW
              : event.key === 'ArrowDown'
                ? BYTES_PER_ROW
                : event.key === 'Home'
                  ? -index
                  : event.key === 'End'
                    ? bytes.length - 1 - index
                    : 0
      if (delta === 0) return
      event.preventDefault()
      const next = Math.max(0, Math.min(bytes.length - 1, index + delta))
      selectByte(next, event.shiftKey, false, column)
      document
        .querySelector<HTMLInputElement>(
          `[data-hex-byte="${next}"][data-hex-column="${column}"]`
        )
        ?.focus()
    },
    [bytes.length, selectByte]
  )

  const updateByte = useCallback(
    (index: number, raw: string): void => {
      if (!/^[0-9a-f]{1,2}$/i.test(raw)) return
      const value = Number.parseInt(raw, 16)
      if (!Number.isInteger(value) || value > 255) return
      const next = bytes.slice()
      next[index] = value
      commit(next, index)
    },
    [bytes, commit]
  )

  const updateAscii = useCallback(
    (index: number, raw: string): void => {
      if (!raw) return
      const next = bytes.slice()
      next[index] = raw.charCodeAt(raw.length - 1) & 0xff
      commit(next, index)
    },
    [bytes, commit]
  )

  const insertByte = useCallback((): void => {
    if (bytes.length >= WORKSPACE_FILE_BINARY_MAX_BYTES) return
    const position = Math.min(selected, bytes.length)
    const next = new Uint8Array(bytes.length + 1)
    next.set(bytes.slice(0, position), 0)
    next[position] = 0
    next.set(bytes.slice(position), position + 1)
    commit(next, position)
  }, [bytes, commit, selected])

  const deleteByte = useCallback((): void => {
    if (bytes.length === 0) return
    const position = Math.min(selected, bytes.length - 1)
    const next = new Uint8Array(bytes.length - 1)
    next.set(bytes.slice(0, position), 0)
    next.set(bytes.slice(position + 1), position)
    commit(next, Math.min(position, Math.max(0, next.length - 1)))
  }, [bytes, commit, selected])

  const searchReplace = useCallback(async (): Promise<void> => {
    const searchInput = await requestPrompt('Find bytes (for example: DE AD BE EF)')
    if (searchInput === null) return
    const search = parseHexPattern(searchInput)
    if (!search || search.length === 0) {
      setValidationError('Enter up to 4096 valid hexadecimal bytes to search for.')
      return
    }
    const replacementInput = await requestPrompt('Replace with bytes')
    if (replacementInput === null) return
    const replacement = parseHexPattern(replacementInput, true)
    if (!replacement) {
      setValidationError('Replacement must contain valid hexadecimal bytes.')
      return
    }
    const next = replaceBytes(bytes, search, replacement)
    if (!next) {
      setValidationError('The replacement would exceed the 16 MiB binary editor limit.')
      return
    }
    if (encodeBase64(next) !== encodedRef.current) commit(next, selected)
  }, [bytes, commit, requestPrompt, selected])

  const toggleBookmark = useCallback((): void => {
    const next = activeBookmarks.includes(selected)
      ? activeBookmarks.filter((value) => value !== selected)
      : [...activeBookmarks, selected].sort((a, b) => a - b)
    setActiveBookmarks(next)
    emitMeta(selected, selections, next, activeTemplate)
  }, [activeTemplate, activeBookmarks, emitMeta, selected, selections])

  const setTemplate = useCallback(async (): Promise<void> => {
    const next = await requestPrompt(
      'Template fields, e.g. header:u8@0,version:u16le@1,label:ascii@3:8',
      activeTemplate ?? ''
    )
    if (next === null) return
    const normalized = next.trim() || null
    if (normalized && parseTemplate(normalized).length === 0) {
      setValidationError('Use field:type@offset syntax with u8, u16le, u32le, or ascii.')
      return
    }
    setActiveTemplate(normalized)
    emitMeta(selected, selections, activeBookmarks, normalized)
  }, [activeBookmarks, activeTemplate, emitMeta, requestPrompt, selected, selections])

  const rowCount = Math.max(1, Math.ceil(bytes.length / BYTES_PER_ROW))
  const virtualizer = useAppVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 27,
    overscan: 8
  })
  const virtualRows = virtualizer.getVirtualItems()
  const rows =
    virtualRows.length > 0
      ? virtualRows
      : [{ index: 0, key: 'fallback-row', start: 0 }]
  const selectionLabel = useMemo(() => {
    if (bytes.length === 0) return 'Empty binary'
    return `${selected.toString(16).padStart(8, '0')} · ${byteText(bytes[selected] ?? 0)}`
  }, [bytes, selected])
  const templateFields = useMemo(() => parseTemplate(activeTemplate), [activeTemplate])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      {promptDialog}
      {validationError ? (
        <div
          role="alert"
          className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger/10 px-2 py-1 text-2xs text-danger"
        >
          <span className="min-w-0 flex-1">{validationError}</span>
          <button
            type="button"
            className={DOCK_TOOLBAR_BTN}
            onClick={() => setValidationError(null)}
          >
            Dismiss
          </button>
        </div>
      ) : null}
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1 border-b border-border/40 px-2 py-1">
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={undo} disabled={past.length === 0}>
          <Icon name="undo" size={11} />
          Undo
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={redo} disabled={future.length === 0}>
          <Icon name="redo" size={11} />
          Redo
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={insertByte}>
          <Icon name="plus" size={11} />
          Insert
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={deleteByte} disabled={bytes.length === 0}>
          <Icon name="trash" size={11} />
          Delete
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={searchReplace}>
          <Icon name="scanSearch" size={11} />
          Find/replace
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={toggleBookmark}>
          <Icon name="star" size={11} />
          Bookmark
        </button>
        <button type="button" className={DOCK_TOOLBAR_BTN} onClick={setTemplate}>
          <Icon name="doc" size={11} />
          Template
        </button>
        <span
          className="ml-auto text-2xs text-muted"
          aria-live="polite"
          title="Cursor position: byte offset in the file and the hex value of the selected byte"
        >
          Offset {selectionLabel}
        </span>
      </div>
      <div
        ref={scrollRef}
        className="min-h-0 min-w-0 flex-1 overflow-auto pl-2 pr-4 py-1 font-mono text-caption"
        role="list"
        aria-label="Hex editor"
      >
        <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
          {rows.map((virtualRow) => {
            const rowStart = virtualRow.index * BYTES_PER_ROW
            return (
              <div
                key={virtualRow.key}
                className="absolute left-0 right-0 flex min-w-[26rem] items-center gap-2 border-b border-border/20 py-0.5"
                style={{ transform: `translateY(${virtualRow.start}px)` }}
                role="listitem"
              >
                <span className="w-16 shrink-0 text-muted" aria-hidden>
                  {rowStart.toString(16).padStart(8, '0')}
                </span>
                <div className="flex shrink-0 gap-0.5">
                  {Array.from({ length: BYTES_PER_ROW }, (_, offset) => {
                    const index = rowStart + offset
                    const exists = index < bytes.length
                    const active = exists && selections.some((range) => index >= range.from && index < range.to)
                    return (
                      <input
                        key={`hex-${index}`}
                        className={`h-5 w-5 rounded border-0 bg-transparent p-0 text-center text-2xs outline-none focus:ring-1 focus:ring-accent ${
                          active ? 'bg-accent/20 text-fg-strong' : 'text-fg'
                        }`}
                        aria-label={exists ? `Byte ${index}` : 'Empty byte'}
                        disabled={!exists}
                        tabIndex={exists && selected === index && selectedColumn === 'hex' ? 0 : -1}
                        data-hex-byte={index}
                        data-hex-column="hex"
                        value={exists ? byteText(bytes[index] ?? 0) : ''}
                        onKeyDown={(event) => {
                          if (exists) handleByteKeyDown(event, index, 'hex')
                        }}
                        onFocus={() => {
                          if (exists) selectByte(index, false, false, 'hex')
                        }}
                        onClick={(event) => {
                          if (exists) {
                            selectByte(
                              index,
                              event.shiftKey,
                              event.ctrlKey || event.metaKey,
                              'hex'
                            )
                          }
                        }}
                        onChange={(event) => {
                          if (exists) updateByte(index, event.target.value)
                        }}
                        maxLength={2}
                      />
                    )
                  })}
                </div>
                <div className="flex shrink-0 gap-0.5 border-l border-border/30 pl-2">
                  {Array.from({ length: BYTES_PER_ROW }, (_, offset) => {
                    const index = rowStart + offset
                    const exists = index < bytes.length
                    return (
                      <input
                        key={`ascii-${index}`}
                        className="h-5 w-3 rounded border-0 bg-transparent p-0 text-center text-2xs text-muted outline-none focus:ring-1 focus:ring-accent"
                        aria-label={exists ? `ASCII byte ${index}` : 'Empty ASCII byte'}
                        disabled={!exists}
                        tabIndex={
                          exists && selected === index && selectedColumn === 'ascii' ? 0 : -1
                        }
                        data-hex-byte={index}
                        data-hex-column="ascii"
                        value={exists ? printable(bytes[index] ?? 0) : ''}
                        onKeyDown={(event) => {
                          if (exists) handleByteKeyDown(event, index, 'ascii')
                        }}
                        onFocus={() => {
                          if (exists) selectByte(index, false, false, 'ascii')
                        }}
                        onChange={(event) => {
                          if (exists) updateAscii(index, event.target.value)
                        }}
                        maxLength={1}
                      />
                    )
                  })}
                </div>
              </div>
            )
          })}
        </div>
      </div>
      {templateFields.length > 0 ? (
        <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-border/30 px-2 py-1 text-2xs text-muted">
          <span className="font-medium text-fg">Template</span>
          {templateFields.map((field) => (
            <span key={`${field.name}:${field.offset}`}>
              {field.name}: {templateValue(bytes, field)}
            </span>
          ))}
        </div>
      ) : null}
      <div className="flex shrink-0 items-center gap-1 border-t border-border/30 px-2 py-1 text-2xs text-muted">
        <span>{bytes.length.toLocaleString()} bytes</span>
        <span className="ml-auto">{activeBookmarks.length} bookmarks</span>
        {activeTemplate ? <span className="truncate">Template: {activeTemplate}</span> : null}
        {selections.length > 0 ? (
          <button
            type="button"
            className={DOCK_TOOLBAR_ICON_BTN}
            aria-label="Clear hex selection"
            title="Clear selection"
            onClick={() => {
              const next: WorkspaceEditorSelection[] = []
              setSelections(next)
              emitMeta(selected, next, activeBookmarks, activeTemplate)
            }}
          >
            <Icon name="close" size={12} />
          </button>
        ) : null}
      </div>
    </div>
  )
}
