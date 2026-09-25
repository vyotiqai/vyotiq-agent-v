import { afterAll, afterEach, vi } from 'vitest'
import { resetActiveRunsForTests } from '@main/agent/runRegistry'
import { resetCircuitBreakersForTests } from '@main/agent/circuitBreaker'

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null,
  applyTitleBarTheme: () => undefined,
  createWindow: () => {
    throw new Error('createWindow is not available in unit tests')
  }
}))

/** jsdom/Node sometimes exposes a broken localStorage — ensure a working Map-backed stub. */
function ensureLocalStorage(): void {
  if (typeof globalThis === 'undefined') return
  const store = new Map<string, string>()
  const storage: Storage = {
    get length() {
      return store.size
    },
    clear: () => {
      store.clear()
    },
    getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(String(key), String(value))
    }
  }
  const needsStub =
    typeof globalThis.localStorage === 'undefined' ||
    typeof globalThis.localStorage?.setItem !== 'function' ||
    typeof globalThis.localStorage?.removeItem !== 'function'
  if (!needsStub) return
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    writable: true,
    value: storage
  })
  if (typeof window !== 'undefined') {
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      writable: true,
      value: storage
    })
  }
}

ensureLocalStorage()

/**
 * jsdom has no requestIdleCallback, so idle-deferred work (e.g. the
 * auto-resume drain in useWorkspaceManager) falls back to a 1s setTimeout and
 * races `waitFor` in tests. Stub it with an immediate scheduler.
 */
function ensureRequestIdleCallback(): void {
  if (typeof window === 'undefined') return
  if (typeof window.requestIdleCallback === 'function') return
  type IdleDeadlineLike = { didTimeout: boolean; timeRemaining: () => number }
  type IdleCb = (deadline: IdleDeadlineLike) => void
  const requestIdleCallback = (cb: IdleCb): number =>
    window.setTimeout(() => cb({ didTimeout: false, timeRemaining: () => 50 }), 0)
  const cancelIdleCallback = (id: number): void => window.clearTimeout(id)
  Object.defineProperty(window, 'requestIdleCallback', {
    configurable: true,
    writable: true,
    value: requestIdleCallback
  })
  Object.defineProperty(window, 'cancelIdleCallback', {
    configurable: true,
    writable: true,
    value: cancelIdleCallback
  })
}

ensureRequestIdleCallback()

/**
 * jsdom has no AnimationEvent or TransitionEvent, and from jsdom 30 its style
 * object lists `WebkitAnimation` and `WebkitTransition`. React takes that as
 * a prefixed browser and listens for `webkitAnimationEnd` — an event no test
 * fires, and no browser the app runs in uses. With the standard constructors
 * defined, React listens for `animationend` / `transitionend`, as it does in
 * Chromium. Must run before react-dom is imported.
 */
function ensureAnimationEvents(): void {
  if (typeof window === 'undefined') return
  if (!('AnimationEvent' in window)) {
    class AnimationEventShim extends Event {
      readonly animationName: string
      readonly elapsedTime: number
      readonly pseudoElement: string
      constructor(type: string, init: AnimationEventInit = {}) {
        super(type, init)
        this.animationName = init.animationName ?? ''
        this.elapsedTime = init.elapsedTime ?? 0
        this.pseudoElement = init.pseudoElement ?? ''
      }
    }
    Object.defineProperty(window, 'AnimationEvent', { configurable: true, writable: true, value: AnimationEventShim })
  }
  if (!('TransitionEvent' in window)) {
    class TransitionEventShim extends Event {
      readonly propertyName: string
      readonly elapsedTime: number
      readonly pseudoElement: string
      constructor(type: string, init: TransitionEventInit = {}) {
        super(type, init)
        this.propertyName = init.propertyName ?? ''
        this.elapsedTime = init.elapsedTime ?? 0
        this.pseudoElement = init.pseudoElement ?? ''
      }
    }
    Object.defineProperty(window, 'TransitionEvent', { configurable: true, writable: true, value: TransitionEventShim })
  }
}

ensureAnimationEvents()

const BLOCKIFIED: Record<string, string> = {
  inline: 'block',
  'inline-block': 'block',
  'inline-flex': 'flex',
  'inline-grid': 'grid',
  'inline-table': 'table'
}
const LAYOUT_CLASS = /(?:^|\s)(?:inline-)?(?:flex|grid)(?:\s|$)/

/**
 * jsdom never sees Tailwind, so it cannot know that a `flex` or `grid` parent
 * blockifies its children; from jsdom 30 it reports a span's UA default
 * `display: inline`. The accessible-name algorithm joins inline children with
 * no space, so a Settings row read "ProvidersOpenAI has no API key" where
 * Chromium, laying the row out as flex, reads "Providers OpenAI has no API
 * key". Report the display the browser would compute for those children.
 */
function blockifyLayoutChildren(): void {
  if (typeof window === 'undefined') return
  const computed = window.getComputedStyle.bind(window)
  window.getComputedStyle = ((element: Element, pseudo?: string | null) => {
    const style = computed(element, pseudo)
    const parentClass = element.parentElement?.getAttribute('class') ?? ''
    const display = BLOCKIFIED[style.display]
    if (pseudo || !display || !LAYOUT_CLASS.test(parentClass)) return style
    return new Proxy(style, {
      get(target, prop) {
        if (prop === 'display') return display
        if (prop === 'getPropertyValue') {
          return (name: string) => (name === 'display' ? display : target.getPropertyValue(name))
        }
        const value: unknown = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
  }) as typeof window.getComputedStyle
}

blockifyLayoutChildren()

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    options: Record<string, unknown> = {}
    open() {}
    loadAddon() {}
    dispose() {}
    onData() {
      return { dispose() {} }
    }
    onResize() {
      return { dispose() {} }
    }
    write() {}
    reset() {}
    scrollToBottom() {}
    focus() {}
    resize() {}
  }
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    activate() {}
    fit() {}
  }
}))

vi.mock('@xterm/addon-web-links', () => ({
  WebLinksAddon: class {
    activate() {}
  }
}))

if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false
    })
  })
}

// `globals: false` means Testing Library never registers its own auto-cleanup, so
// rendered trees would stay mounted for the rest of the file and their timers can
// outlive the environment.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react')
  afterEach(cleanup)
}

afterEach(() => {
  resetActiveRunsForTests()
  resetCircuitBreakersForTests()
  vi.clearAllMocks()
})

// Forked pool workers run many files in one process; without an explicit
// collection the jsdom environment and module registry of the previous file
// stay reachable until the worker's heap limit kills the whole run. Exposed
// via --expose-gc in vitest.config.ts execArgv.
afterAll(() => {
  ;(globalThis as unknown as { gc?: () => void }).gc?.()
})
