import { createContext, useContext, useMemo, type KeyboardEvent, type ReactNode } from 'react'
import type { SlashCommandDescriptor } from '@shared/ipc'
import type { MentionMenuItem } from '../../../../renderer/src/features/chat/components/composer/mentionModel'
import { DICTATED, STRUCTURED, type Segment } from './data'
import { mentionIcon, useMentionRows, useSlashRows } from './menus'
import { readSegments, useGlass, type Trigger } from './store'

/*
  What the composer's controls do, as the app's do, against the mockup's own
  state: a click moves the scene on (Send starts a run, Stop ends it, the mic
  opens a take, Structure writes a brief) instead of leaving it where the
  viewer put it. Nothing leaves the page: Send has no model behind it, and a
  run stays live until it is stopped.
*/

/** Stands in for the @ or / trigger while the field's words are read back (a private-use character). */
const MARK = ''
/** How long the sample Structure takes to write its brief. */
const STRUCTURE_MS = 1800

/** The words before the caret, if the caret is in `root`. */
function textBeforeCaret(root: HTMLElement): string | null {
  const sel = window.getSelection()
  if (!sel || !sel.rangeCount) return null
  const r = sel.getRangeAt(0)
  if (!root.contains(r.endContainer)) return null
  const pre = document.createRange()
  pre.selectNodeContents(root)
  pre.setEnd(r.endContainer, r.endOffset)
  return pre.toString()
}

/** `@query` after a space or at the start opens the @ menu; `/query` as the whole line so far opens the / menu. */
export function readTrigger(root: HTMLElement): Trigger | null {
  const before = textBeforeCaret(root)
  if (before === null) return null
  const slash = /^\/([^\s/]*)$/.exec(before)
  if (slash) return { kind: 'slash', query: slash[1] ?? '', raw: slash[0], start: 0 }
  const at = /(?:^|\s)(@([^\s@]*))$/.exec(before)
  if (at) {
    const raw = at[1] ?? '@'
    return { kind: 'mention', query: at[2] ?? '', raw, start: before.length - raw.length }
  }
  return null
}

/** The segments' words, chips by their label: what a queued row previews. */
function plainText(segments: Segment[]): string {
  return segments
    .map((s) => {
      if (s.type === 'text') return s.value
      if (s.kind === 'file') return s.path.split('/').pop() ?? s.path
      if (s.kind === 'slash') return `/${s.trigger}`
      return `@${s.label}`
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The chip an @ row leaves in the field, or null for a row that browses (a list, "Show N more"). */
function mentionChip(item: MentionMenuItem): Segment | null {
  switch (item.kind) {
    case 'file':
    case 'folder':
    case 'docs':
      return { type: 'chip', kind: 'file', path: item.path }
    case 'branch':
      return { type: 'chip', kind: 'branch', label: item.label }
    case 'nav':
    case 'show-more':
      return null
    default:
      return { type: 'chip', kind: 'context', label: item.label, icon: mentionIcon(item) }
  }
}

/** Where the trigger's last character sits: the caret, or (the field not focused) the last text that ends with it. */
function triggerEnd(root: HTMLElement, raw: string): { node: Text; offset: number } | null {
  const sel = window.getSelection()
  const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null
  if (r && root.contains(r.endContainer) && r.endContainer.nodeType === Node.TEXT_NODE) {
    const node = r.endContainer as Text
    if (node.data.slice(0, r.endOffset).endsWith(raw)) return { node, offset: r.endOffset }
  }
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  let last: Text | null = null
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if ((n as Text).data.length) last = n as Text
  return last && last.data.endsWith(raw) ? { node: last, offset: last.data.length } : null
}

/** Put the caret at the end of `root`, focused. */
function caretToEnd(root: HTMLElement): void {
  root.focus({ preventScroll: true })
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(root)
  range.collapse(false)
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function useComposerActions() {
  const g = useGlass()
  const { scene, patch, filled, attached, setAttached, queue, setQueue, checks, setChecks, trigger, setTrigger, toggle, close, fieldRef, pop } =
    g
  const mention = useMentionRows(trigger?.kind === 'mention' ? trigger.query : '')
  const slash = useSlashRows(trigger?.kind === 'slash' ? trigger.query : '')
  // Structure's sample brief arrives after a beat; its timer and the words it replaced live in the store.
  const structureRef = g.structureMemo
  const caretAfterRef = g.caretAfter

  return useMemo(() => {
    const ready = !scene.readiness && scene.take !== 'listening' && scene.structure !== 'working'
    const canSend = ready && filled
    const words = (): Segment[] => (fieldRef.current ? readSegments(fieldRef.current, scene.segments) : scene.segments)
    const cleared = { segments: [] as Segment[], take: null, structure: null, attachments: false } as const

    const clearTimer = (): void => {
      const s = structureRef.current
      if (s.timer !== null) window.clearTimeout(s.timer)
      s.timer = null
    }
    const writeBrief = (before: Segment[]): void => {
      structureRef.current.before = before
      clearTimer()
      patch({ structure: 'working', segments: before, take: null })
      structureRef.current.timer = window.setTimeout(() => {
        structureRef.current.timer = null
        patch({ structure: 'done', segments: STRUCTURED })
      }, STRUCTURE_MS)
    }

    const actions = {
      ready,
      canSend,
      /** The line's Send: the run starts, the field empties. */
      send: (): void => {
        if (!canSend) return
        patch({ ...cleared, running: true, error: false })
      },
      /** While a run is live: the words wait their turn in the queue above. */
      queueIt: (): void => {
        if (!canSend) return
        const preview = plainText(words()) || 'An attachment'
        setQueue([...queue, { id: `q${Date.now()}`, preview, offline: false }])
        patch(cleared)
      },
      /** While a run is live: the words go into the run now. */
      sendNow: (): void => {
        if (!canSend) return
        patch(cleared)
      },
      /** The line's action, by what the run is doing: Send, or Queue while it is live. */
      submit: (): void => (scene.running ? actions.queueIt() : actions.send()),
      stop: (): void => patch({ running: false }),
      /** Edit and rerun: the run starts again from the edited words, back on the line. */
      rerun: (): void => {
        if (!canSend) return
        patch({ ...cleared, surface: 'line', running: true, error: false })
      },
      cancelEdit: (): void => patch({ ...cleared, surface: 'line' }),
      /** The brief: the task starts, and the line takes over. */
      startTask: (): void => {
        if (!canSend) return
        patch({ ...cleared, surface: 'line', running: true, error: false })
      },
      retry: (): void => patch({ error: false, running: true }),
      dismissError: (): void => patch({ error: false }),
      addKey: (): void => patch({ readiness: false }),

      // ── Dictation ──
      startTake: (): void => {
        if (scene.take === 'listening' || scene.structure === 'working') return
        close()
        patch({ take: 'listening', micReady: true })
      },
      insertTake: (): void => patch({ take: 'inserted' }),
      discardTake: (): void => patch({ take: null }),
      /** Ctrl+Enter from a take: its words go straight out, as Send (or Queue, Rerun, Start task) would. */
      sendTake: (): void => {
        const all: Segment[] = [...scene.segments, { type: 'text', value: (scene.segments.length ? ' ' : '') + DICTATED }]
        if (scene.readiness) return
        if (scene.surface !== 'line') patch({ ...cleared, surface: 'line', running: true, error: false })
        else if (scene.running) {
          setQueue([...queue, { id: `q${Date.now()}`, preview: plainText(all), offline: false }])
          patch(cleared)
        } else patch({ ...cleared, running: true, error: false })
      },
      /** Undo a take: the words it added go, the typed ones stay. */
      undoTake: (): void => patch({ take: null, segments: scene.segments }),

      // ── Structure ──
      structure: (): void => {
        if (!filled || scene.structure === 'working' || scene.take === 'listening') return
        writeBrief(words())
      },
      cancelStructure: (): void => {
        clearTimer()
        patch({ structure: null })
      },
      undoStructure: (): void => patch({ structure: null, segments: structureRef.current.before ?? scene.segments }),
      retryStructure: (): void => writeBrief(structureRef.current.before ?? scene.segments),
      hideStructure: (): void => patch({ structure: null }),

      // ── Queue ──
      removeQueued: (id: string): void => setQueue(queue.filter((q) => q.id !== id)),
      /** A queued row's Send now: it interrupts the run and goes in, so it leaves the queue. */
      sendQueuedNow: (id: string): void => setQueue(queue.filter((q) => q.id !== id)),
      /** Edit a queued row: its words come back to the field, and it leaves the queue. */
      editQueued: (id: string): void => {
        const entry = queue.find((q) => q.id === id)
        if (!entry) return
        setQueue(queue.filter((q) => q.id !== id))
        patch({ segments: [{ type: 'text', value: entry.preview }] })
      },

      // ── Done when ──
      addCheck: (text: string): boolean => {
        const t = text.trim()
        if (!t || checks.includes(t)) return false
        setChecks([...checks, t])
        return true
      },
      removeCheck: (text: string): void => setChecks(checks.filter((c) => c !== text)),

      // ── Attach ──
      attachPick: (id: string): void => {
        close()
        if (id === 'files') setAttached({ ...attached, file: true })
        else if (id === 'image' || id === 'screenshot') setAttached({ ...attached, image: true })
        else if (id === 'mention') {
          // "Mention a file" types the @, and the @ menu opens from it.
          const el = fieldRef.current
          if (!el || el.getAttribute('contenteditable') !== 'true') return
          caretToEnd(el)
          const text = el.textContent ?? ''
          document.execCommand('insertText', false, text && !/\s$/.test(text) ? ' @' : '@')
        }
      },
      removeAttachment: (which: 'image' | 'file'): void => setAttached({ ...attached, [which]: false }),

      // ── Mic setup ──
      chooseDictation: (): void => {
        close()
        patch({ micReady: true, take: 'listening' })
      },

      // ── @ and / ──
      /** A picked row replaces its trigger with a chip, and the caret goes on after it. */
      pick: (chip: Segment): void => {
        const el = fieldRef.current
        const t = trigger
        setTrigger(null)
        if (!el || !t) return
        const at = triggerEnd(el, t.raw)
        if (at) at.node.replaceData(at.offset - t.raw.length, t.raw.length, MARK)
        else el.append(MARK)
        const segments: Segment[] = []
        let after: number | null = null
        for (const s of readSegments(el, scene.segments)) {
          if (s.type !== 'text' || !s.value.includes(MARK)) {
            segments.push(s)
            continue
          }
          const [head = '', tail = ''] = s.value.split(MARK)
          if (head) segments.push({ type: 'text', value: head })
          after = segments.length
          segments.push(chip, { type: 'text', value: ` ${tail.replace(/^ /, '')}` })
        }
        caretAfterRef.current = after
        patch({ segments })
      },
      pickMention: (item: MentionMenuItem): void => {
        if (item.kind === 'nav') g.setMentionView(item.view)
        else if (item.kind === 'show-more') g.setMentionMore(true)
        else {
          const chip = mentionChip(item)
          if (chip) actions.pick(chip)
        }
      },
      pickSlash: (cmd: SlashCommandDescriptor): void => actions.pick({ type: 'chip', kind: 'slash', trigger: cmd.trigger, slashKind: cmd.kind }),

      /** Each edit: what is typed, and whether an @ or / menu should follow it. */
      onEdit: (el: HTMLDivElement): void => {
        g.setTyped(Boolean((el.textContent ?? '').trim()) || Boolean(el.querySelector('[data-seg]')))
        const next = readTrigger(el)
        if (next?.kind !== trigger?.kind || next?.raw !== trigger?.raw || next?.start !== trigger?.start) setTrigger(next)
      },

      /**
       * The composer's keys, as the app binds them: Enter sends (a new line in
       * the brief), Shift+Enter is Send now while live, Ctrl+Enter starts the
       * brief, Ctrl+Shift+Enter structures, Ctrl+M dictates, Ctrl+. switches
       * mode (⇧Tab too, in an empty box), and Esc backs out of whatever is
       * open: a take, Structure, the edit, then the run.
       */
      onKeyDown: (e: KeyboardEvent<HTMLElement>): void => {
        if (e.nativeEvent.isComposing || e.defaultPrevented) return
        const inField = e.target === fieldRef.current
        const mod = e.ctrlKey || e.metaKey

        if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'm') {
          e.preventDefault()
          if (scene.take === 'listening') actions.insertTake()
          else if (scene.micReady) actions.startTake()
          else toggle('mic')
          return
        }
        if (mod && e.key === '.') {
          e.preventDefault()
          g.setMode(g.mode === 'agent' ? 'ask' : 'agent')
          return
        }

        // The open @ or / menu has the arrows, Enter and Tab; Esc is the popover's.
        const menu = pop === 'mention' || pop === 'slash' ? pop : null
        if (menu && inField) {
          const count = menu === 'mention' ? mention.order.length : slash.commands.length
          if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
            e.preventDefault()
            g.setMenuActive((g.menuActive + (e.key === 'ArrowDown' ? 1 : -1) + count) % count)
            return
          }
          if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && !mod && count) {
            e.preventDefault()
            if (menu === 'mention') {
              const item = mention.items[mention.order[g.menuActive] ?? -1]
              if (item) actions.pickMention(item)
            } else {
              const cmd = slash.commands[g.menuActive]
              if (cmd) actions.pickSlash(cmd)
            }
            return
          }
          if (e.key === 'Escape') return
        }

        if (scene.take === 'listening') {
          if (e.key === 'Escape') {
            e.preventDefault()
            actions.discardTake()
          } else if (e.key === 'Enter' && mod) {
            e.preventDefault()
            actions.sendTake()
          } else if (e.key === 'Enter') {
            e.preventDefault()
            actions.insertTake()
          }
          return
        }

        if (e.key === 'Escape' && !pop) {
          if (scene.structure === 'working') actions.cancelStructure()
          else if (scene.surface === 'inline') actions.cancelEdit()
          else if (scene.running && scene.surface === 'line') actions.stop()
          else return
          e.preventDefault()
          return
        }

        if (mod && !e.shiftKey && e.key.toLowerCase() === 'z' && inField) {
          if (scene.take === 'inserted') {
            e.preventDefault()
            actions.undoTake()
          } else if (scene.structure === 'done') {
            e.preventDefault()
            actions.undoStructure()
          }
          return
        }

        if (e.key === 'Tab' && e.shiftKey && inField && !filled) {
          e.preventDefault()
          g.setMode(g.mode === 'agent' ? 'ask' : 'agent')
          return
        }

        if (e.key !== 'Enter' || !inField) return
        if (mod && e.shiftKey) {
          e.preventDefault()
          actions.structure()
          return
        }
        if (scene.surface === 'brief') {
          e.preventDefault()
          if (mod) actions.startTask()
          else document.execCommand('insertText', false, '\n')
          return
        }
        if (e.shiftKey) {
          e.preventDefault()
          if (scene.running && scene.surface === 'line' && canSend) actions.sendNow()
          else document.execCommand('insertText', false, '\n')
          return
        }
        e.preventDefault()
        if (scene.surface === 'inline') actions.rerun()
        else actions.submit()
      }
    }
    return actions
  }, [
    scene,
    patch,
    filled,
    attached,
    setAttached,
    queue,
    setQueue,
    checks,
    setChecks,
    trigger,
    setTrigger,
    toggle,
    close,
    fieldRef,
    pop,
    g,
    mention,
    slash,
    structureRef,
    caretAfterRef
  ])
}

export type ComposerActions = ReturnType<typeof useComposerActions>

const Ctx = createContext<ComposerActions | null>(null)

/** One set of actions for the whole composer, inside its GlassProvider. */
export function ActionsProvider({ children }: { children: ReactNode }) {
  const actions = useComposerActions()
  return <Ctx.Provider value={actions}>{children}</Ctx.Provider>
}

export function useActions(): ComposerActions {
  const v = useContext(Ctx)
  if (!v) throw new Error('useActions outside ActionsProvider')
  return v
}
