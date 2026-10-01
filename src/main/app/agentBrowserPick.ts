import type { WebContents } from 'electron'
import { sanitizePickedElement } from '../../shared/browserPick'
import type { BrowserPickedElement } from '../../shared/ipc'

/**
 * Pick an element in a Browser tab for the composer.
 *
 * Everything runs through the DevTools protocol, so nothing is added to the
 * page's DOM or its script world: Chromium's own inspect overlay outlines the
 * element under the pointer and reports the click, and the element is read in
 * an isolated world the page's scripts cannot reach. The only code run in the
 * page is the fixed source below; the page's strings come back as data and are
 * clamped (`sanitizePickedElement`) before they leave this module.
 *
 * Keyboard: with the page focused, the arrow keys walk the tree (Up to the
 * parent, Down to the first child, Left and Right between siblings), Tab moves
 * the page's own focus and the outline follows it, Enter or Space picks, and
 * Esc stops.
 */

export type PickEndReason = 'stopped' | 'escape' | 'navigated' | 'detached' | 'destroyed'

export type ElementPickSession = {
  stop: (reason?: PickEndReason) => void
  /** False once the session ended, whatever ended it. */
  active: () => boolean
}

export type StartElementPickOpts = {
  wc: WebContents
  /** The tab's `@eN` refs from its last snapshot, to name the picked element by. */
  refs: () => ReadonlyArray<{ id: string; selector: string }>
  onPick: (element: BrowserPickedElement) => void
  onEnd: (reason: PickEndReason) => void
  /**
   * A click landed on something that could not be read from the page's own
   * document — in practice an element inside a same-origin frame, which the
   * overlay reports but the top document's isolated world cannot resolve.
   */
  onMiss?: () => void
}

type NodeRef = { backendNodeId: number } | { nodeId: number }
type MoveDirection = 'parent' | 'child' | 'next' | 'prev'

const OBJECT_GROUP = 'vyotiq-pick'
const WORLD_NAME = 'vyotiq-pick'
/** How many snapshot refs are matched against the picked element. */
const MAX_REFS = 2000

/**
 * Chromium's inspect overlay, drawn by the compositor above the page. The
 * protocol takes RGBA, not CSS, and the overlay lives in the browsed page,
 * outside the app's skins — so these are fixed values, like DevTools' own.
 */
const HIGHLIGHT_CONFIG = {
  showInfo: true,
  showAccessibilityInfo: true,
  showStyles: false,
  contentColor: { r: 37, g: 99, b: 235, a: 0.16 },
  paddingColor: { r: 37, g: 99, b: 235, a: 0.08 },
  borderColor: { r: 37, g: 99, b: 235, a: 0.9 },
  marginColor: { r: 37, g: 99, b: 235, a: 0.04 }
}

/** Run on the element (`this`) in the isolated world; returns plain data. */
const DESCRIBE_ELEMENT = `function (refSelectors) {
  const el = this && this.nodeType === 1 ? this : (this && this.parentElement)
  if (!el) return null
  const esc = (v) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(v) : String(v).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\\\' + c))
  const unique = (sel) => {
    try {
      const all = document.querySelectorAll(sel)
      return all.length === 1 && all[0] === el
    } catch (e) {
      return false
    }
  }
  const quoteAttr = (v) => '"' + String(v).replace(/\\\\/g, '\\\\\\\\').replace(/"/g, '\\\\"') + '"'
  const selectorOf = () => {
    if (el.id && el.id.length <= 120 && unique('#' + esc(el.id))) return '#' + esc(el.id)
    for (const attr of ['data-testid', 'data-test', 'data-qa', 'data-cy']) {
      const v = el.getAttribute(attr)
      if (v && v.length <= 120) {
        const sel = '[' + attr + '=' + quoteAttr(v) + ']'
        if (unique(sel)) return sel
      }
    }
    const parts = []
    let node = el
    while (node && node.nodeType === 1 && parts.length < 12) {
      const tag = node.tagName.toLowerCase()
      if (node !== el && node.id && node.id.length <= 120) {
        const withId = ['#' + esc(node.id)].concat(parts).join(' > ')
        if (unique(withId)) return withId
      }
      const parent = node.parentElement
      if (!parent) {
        parts.unshift(tag)
        break
      }
      const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName)
      parts.unshift(same.length > 1 ? tag + ':nth-of-type(' + (same.indexOf(node) + 1) + ')' : tag)
      const sel = parts.join(' > ')
      if (unique(sel)) return sel
      node = parent
    }
    return parts.join(' > ')
  }
  const tag = el.tagName.toLowerCase()
  const roleOf = () => {
    const explicit = el.getAttribute('role')
    if (explicit) return explicit
    if (tag === 'a' && el.hasAttribute('href')) return 'link'
    if (tag === 'button') return 'button'
    if (tag === 'select') return 'combobox'
    if (tag === 'textarea') return 'textbox'
    if (tag === 'img') return 'img'
    if (/^h[1-6]$/.test(tag)) return 'heading'
    if (tag === 'input') {
      const t = (el.getAttribute('type') || 'text').toLowerCase()
      if (t === 'submit' || t === 'button' || t === 'reset' || t === 'image') return 'button'
      if (t === 'checkbox' || t === 'radio') return t
      return 'textbox'
    }
    return ''
  }
  // Never a form value: a picked password field must not carry what was typed.
  const nameOf = () =>
    el.getAttribute('aria-label') ||
    el.getAttribute('placeholder') ||
    el.getAttribute('title') ||
    el.getAttribute('alt') ||
    (el.labels && el.labels[0] && el.labels[0].innerText) ||
    ''
  const text = tag === 'input' ? '' : String(el.innerText || el.textContent || '').slice(0, 2000)
  const r = el.getBoundingClientRect()
  let refIndex = -1
  const list = Array.isArray(refSelectors) ? refSelectors : []
  for (let i = 0; i < list.length; i++) {
    try {
      if (document.querySelector(list[i]) === el) {
        refIndex = i
        break
      }
    } catch (e) {
      /* a stale ref's selector */
    }
  }
  return {
    selector: selectorOf(),
    tag,
    role: roleOf(),
    name: String(nameOf()).slice(0, 2000),
    text,
    bounds: { x: r.left, y: r.top, width: r.width, height: r.height },
    refIndex
  }
}`

/** Run on the element (`this`); the neighbour in `dir`, or null to stay put. */
const MOVE_FROM_ELEMENT = `function (dir) {
  const skip = (n) => !!n && /^(SCRIPT|STYLE|TEMPLATE|NOSCRIPT|LINK|META)$/.test(n.tagName)
  let next = null
  if (dir === 'parent') {
    next = this.parentElement && this.parentElement !== document.documentElement ? this.parentElement : null
  } else if (dir === 'child') {
    next = this.firstElementChild
    while (skip(next)) next = next.nextElementSibling
  } else if (dir === 'next') {
    next = this.nextElementSibling
    while (skip(next)) next = next.nextElementSibling
  } else if (dir === 'prev') {
    next = this.previousElementSibling
    while (skip(next)) next = next.previousElementSibling
  }
  return next || null
}`

const ARROW_MOVES: Record<string, MoveDirection> = {
  ArrowUp: 'parent',
  ArrowDown: 'child',
  ArrowLeft: 'prev',
  ArrowRight: 'next'
}

type RemoteObject = { objectId?: string; subtype?: string; value?: unknown }

/** Arm the inspect overlay on `wc`. Throws when the protocol session cannot start. */
export async function startElementPick(opts: StartElementPickOpts): Promise<ElementPickSession> {
  const { wc, onPick, onEnd } = opts
  const dbg = wc.debugger
  // The user's DevTools or a capture may hold the session already; share it.
  const attachedHere = !dbg.isAttached()
  if (attachedHere) dbg.attach('1.3')

  function send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>): Promise<T> {
    return dbg.sendCommand(method, params) as Promise<T>
  }

  let ended = false
  /** The element the keyboard is on: the last one hovered, walked to, or picked. */
  let current: NodeRef | null = null
  let worldId: number | null = null
  let queue: Promise<void> = Promise.resolve()

  const enqueue = (task: () => Promise<void>): void => {
    queue = queue.then(
      () => (ended ? undefined : task()),
      () => undefined
    ).catch(() => {
      // A node gone mid-walk or a page mid-load: the next key tries again.
    })
  }

  const isolatedWorld = async (): Promise<number> => {
    if (worldId != null) return worldId
    const tree = await send<{ frameTree?: { frame?: { id?: string } } }>('Page.getFrameTree')
    const frameId = tree.frameTree?.frame?.id
    if (!frameId) throw new Error('No main frame')
    const world = await send<{ executionContextId: number }>('Page.createIsolatedWorld', {
      frameId,
      worldName: WORLD_NAME,
      grantUniveralAccess: false
    })
    worldId = world.executionContextId
    return worldId
  }

  const resolveObject = async (ref: NodeRef): Promise<string | null> => {
    const resolve = async (): Promise<string | null> => {
      const executionContextId = await isolatedWorld()
      const { object } = await send<{ object: RemoteObject }>('DOM.resolveNode', {
        ...ref,
        executionContextId,
        objectGroup: OBJECT_GROUP
      })
      return object.objectId ?? null
    }
    try {
      return await resolve()
    } catch {
      // The world goes with its document; make a fresh one once.
      worldId = null
      return resolve()
    }
  }

  const describeObject = async (objectId: string): Promise<NodeRef | null> => {
    const { node } = await send<{ node?: { backendNodeId?: number; nodeType?: number } }>(
      'DOM.describeNode',
      { objectId }
    )
    return typeof node?.backendNodeId === 'number' && node.nodeType === 1
      ? { backendNodeId: node.backendNodeId }
      : null
  }

  const highlight = async (ref: NodeRef): Promise<void> => {
    await send('DOM.scrollIntoViewIfNeeded', { ...ref }).catch(() => undefined)
    await send('Overlay.highlightNode', { ...ref, highlightConfig: HIGHLIGHT_CONFIG })
  }

  /** The page's focused element (the body when nothing is), for a keyboard start. */
  const focusedElement = async (): Promise<NodeRef | null> => {
    const contextId = await isolatedWorld()
    const { result } = await send<{ result: RemoteObject }>('Runtime.evaluate', {
      expression: 'document.activeElement || document.body',
      contextId,
      objectGroup: OBJECT_GROUP
    })
    return result.objectId ? describeObject(result.objectId) : null
  }

  const followFocus = async (): Promise<void> => {
    const ref = await focusedElement()
    if (!ref) return
    current = ref
    await highlight(ref)
  }

  const move = async (dir: MoveDirection): Promise<void> => {
    if (!current) {
      await followFocus()
      return
    }
    const objectId = await resolveObject(current)
    if (!objectId) return
    const { result } = await send<{ result: RemoteObject }>('Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: MOVE_FROM_ELEMENT,
      arguments: [{ value: dir }],
      objectGroup: OBJECT_GROUP
    })
    const next = result.objectId ? await describeObject(result.objectId) : null
    if (!next) return
    current = next
    await highlight(next)
  }

  const pick = async (ref: NodeRef): Promise<void> => {
    const objectId = await resolveObject(ref)
    if (!objectId) return
    const refList = opts.refs().slice(0, MAX_REFS)
    const described = await send<{ result: RemoteObject; exceptionDetails?: unknown }>(
      'Runtime.callFunctionOn',
      {
        objectId,
        functionDeclaration: DESCRIBE_ELEMENT,
        arguments: [{ value: refList.map((r) => r.selector) }],
        returnByValue: true,
        objectGroup: OBJECT_GROUP
      }
    )
    if (described.exceptionDetails) return
    const value = described.result.value as Record<string, unknown> | null | undefined
    if (!value || typeof value !== 'object') return
    // The accessibility tree's role and name are what assistive tech and the
    // snapshot's readers see; the DOM guesses above are the fallback.
    let axRole: string | undefined
    let axName: string | undefined
    try {
      const { nodes } = await send<{
        nodes?: Array<{ role?: { value?: unknown }; name?: { value?: unknown } }>
      }>('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })
      const node = nodes?.[0]
      if (typeof node?.role?.value === 'string') axRole = node.role.value
      if (typeof node?.name?.value === 'string') axName = node.name.value
    } catch {
      // Older protocol or a detached node: keep the DOM's answer.
    }
    const role = axRole && !/^(generic|none|presentation)$/i.test(axRole) ? axRole : value.role
    const refIndex = typeof value.refIndex === 'number' ? value.refIndex : -1
    const element = sanitizePickedElement({
      ...value,
      role,
      name: axName || value.name,
      url: wc.getURL(),
      ref: refIndex >= 0 ? refList[refIndex]?.id : undefined
    })
    if (!element || ended) return
    current = ref
    onPick(element)
  }

  const onMessage = (_event: unknown, method: string, params: Record<string, unknown> | undefined): void => {
    if (ended) return
    if (method === 'Overlay.inspectNodeRequested') {
      const backendNodeId = params?.backendNodeId
      if (typeof backendNodeId === 'number') {
        enqueue(async () => {
          // A node that will not resolve here (inside a frame) says so, rather
          // than the click looking ignored; page data that fails the checks
          // is dropped quietly, as before.
          try {
            await pick({ backendNodeId })
          } catch {
            if (!ended) opts.onMiss?.()
          }
        })
      }
    } else if (method === 'Overlay.nodeHighlightRequested') {
      const nodeId = params?.nodeId
      if (typeof nodeId === 'number') current = { nodeId }
    }
  }

  const onInput = (event: { preventDefault: () => void }, input: Electron.Input): void => {
    if (ended) return
    if (input.type === 'keyUp') {
      // Tab is the page's own: let it move focus, then outline where it went.
      if (input.key === 'Tab') enqueue(followFocus)
      return
    }
    if (input.type !== 'keyDown' || input.control || input.meta || input.alt) return
    if (input.key === 'Escape') {
      event.preventDefault()
      end('escape')
      return
    }
    if (input.key === 'Enter' || input.key === ' ') {
      event.preventDefault()
      if (input.isAutoRepeat) return
      enqueue(async () => {
        if (current) await pick(current)
        else await followFocus()
      })
      return
    }
    const dir = ARROW_MOVES[input.key]
    if (dir) {
      event.preventDefault()
      enqueue(() => move(dir))
    }
  }

  const onDetach = (): void => end('detached')
  const onNavigate = (): void => end('navigated')
  const onDestroyed = (): void => end('destroyed')

  function end(reason: PickEndReason): void {
    if (ended) return
    ended = true
    dbg.removeListener('message', onMessage)
    dbg.removeListener('detach', onDetach)
    wc.removeListener('before-input-event', onInput)
    wc.removeListener('did-navigate', onNavigate)
    wc.removeListener('destroyed', onDestroyed)
    if (!wc.isDestroyed() && dbg.isAttached()) {
      void send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT_CONFIG })
        .catch(() => undefined)
        .then(() => send('Overlay.hideHighlight').catch(() => undefined))
        .then(() => send('Runtime.releaseObjectGroup', { objectGroup: OBJECT_GROUP }).catch(() => undefined))
        .finally(() => {
          if (!attachedHere) return
          try {
            dbg.detach()
          } catch {
            // already gone with its page
          }
        })
    }
    onEnd(reason)
  }

  dbg.on('message', onMessage)
  dbg.on('detach', onDetach)
  wc.on('before-input-event', onInput)
  wc.on('did-navigate', onNavigate)
  wc.on('destroyed', onDestroyed)

  try {
    await send('DOM.enable')
    // Hover reports node ids, which exist only once the document was requested.
    await send('DOM.getDocument', { depth: 0 })
    await send('Overlay.enable')
    await send('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT_CONFIG })
  } catch (err) {
    end('stopped')
    throw err
  }

  return { stop: (reason = 'stopped') => end(reason), active: () => !ended }
}
