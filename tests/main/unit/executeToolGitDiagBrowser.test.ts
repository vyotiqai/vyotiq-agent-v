import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { DEFAULT_SETTINGS } from '@shared/ipc'
import { canGit } from '../../helpers/canGit'

vi.mock('@main/settings/settings', () => ({
  getSettings: () => ({
    ...DEFAULT_SETTINGS,
    diagnosticsCommand: 'node -e "console.log(\'src/a.ts:1:1: error boom\')"'
  })
}))

vi.mock('@main/app/window', () => ({
  getMainWindow: () => null
}))

const commitPaths = vi.fn(async () => ({
  committed: true,
  pushed: false,
  detail: 'Committed 1 file',
  skipped: [] as string[]
}))

vi.mock('@main/git/git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/git/git')>()
  return {
    ...actual,
    commitPaths: (...args: unknown[]) => commitPaths(...args)
  }
})

const manageTabs = vi.fn(async () => '  tab-1  Home  https://example.com/')
const navigateUrl = vi.fn(async () => 'navigated: https://example.com/')
const snapshotPage = vi.fn(async () => 'refs:\n@e1 button Submit')
const clickSelector = vi.fn(async () => 'clicked @e1')
const typeText = vi.fn(async () => 'typed text')
const scrollPage = vi.fn(async () => 'scrolled')
const fillSelector = vi.fn(async () => 'filled @e3')
const goBack = vi.fn(async () => 'back: https://example.com/prev')
const goForward = vi.fn(async () => 'forward: https://example.com/next')
const waitForSelector = vi.fn(async () => 'found #app')
const waitForUrl = vi.fn(async () => 'url matched /dashboard')
const pressKey = vi.fn(async () => 'pressed Enter')
const selectOption = vi.fn(async () => 'selected v1')

vi.mock('@main/app/agentBrowser', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/app/agentBrowser')>()
  return {
    formatWaitTimeoutMessage: actual.formatWaitTimeoutMessage,
    manageTabs: (...args: unknown[]) => manageTabs(...args),
    navigateUrl: (...args: unknown[]) => navigateUrl(...args),
    snapshotPage: (...args: unknown[]) => snapshotPage(...args),
    clickSelector: (...args: unknown[]) => clickSelector(...args),
    typeText: (...args: unknown[]) => typeText(...args),
    scrollPage: (...args: unknown[]) => scrollPage(...args),
    fillSelector: (...args: unknown[]) => fillSelector(...args),
    goBack: (...args: unknown[]) => goBack(...args),
    goForward: (...args: unknown[]) => goForward(...args),
    waitForSelector: (...args: unknown[]) => waitForSelector(...args),
    waitForUrl: (...args: unknown[]) => waitForUrl(...args),
    pressKey: (...args: unknown[]) => pressKey(...args),
    selectOption: (...args: unknown[]) => selectOption(...args)
  }
})

const toolWebFetch = vi.fn(async () => '# Fetched page')

vi.mock('@main/net/webFetch', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/net/webFetch')>()
  return {
    ...actual,
    toolWebFetch: (...args: unknown[]) => toolWebFetch(...args)
  }
})

import { executeTool } from '@main/agent/tools'

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' })
}

describe('executeTool git / diagnostics / browser', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-exec-tools-'))
    manageTabs.mockClear()
    navigateUrl.mockClear()
    snapshotPage.mockClear()
    clickSelector.mockClear()
    commitPaths.mockClear()
    toolWebFetch.mockClear()
  })

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it.skipIf(!canGit)('git_status returns formatted status for a real repo', async () => {
    git(workspace, 'init', '--initial-branch=main')
    git(workspace, 'config', 'user.email', 'test@example.com')
    git(workspace, 'config', 'user.name', 'Test')
    git(workspace, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(workspace, 'readme.txt'), 'hello\n', 'utf8')
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-m', 'init')

    const result = await executeTool('git_status', '{}', workspace, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(result.content).toContain('branch: main')
    expect(result.content).toContain('(clean)')
  })

  it('git_diff reports not-a-repo as ok content', async () => {
    const result = await executeTool('git_diff', '{}', workspace, new AbortController().signal)
    expect(result.ok).toBe(true)
    expect(result.content).toBe('Not a git repository')
  })

  it.skipIf(!canGit)('git_diff returns unified diff for a dirty tracked file', async () => {
    git(workspace, 'init', '--initial-branch=main')
    git(workspace, 'config', 'user.email', 'test@example.com')
    git(workspace, 'config', 'user.name', 'Test')
    git(workspace, 'config', 'commit.gpgsign', 'false')
    writeFileSync(join(workspace, 'kept.txt'), 'one\n', 'utf8')
    git(workspace, 'add', '-A')
    git(workspace, 'commit', '-m', 'init')
    writeFileSync(join(workspace, 'kept.txt'), 'one\ntwo\n', 'utf8')

    const result = await executeTool(
      'git_diff',
      JSON.stringify({ path: 'kept.txt' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toMatch(/\+two|@@/)
  })

  it('git_commit refuses empty scope without paths or run mutations', async () => {
    const result = await executeTool(
      'git_commit',
      JSON.stringify({ message: 'feat: test commit' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(commitPaths).not.toHaveBeenCalled()
    expect(result.content).toMatch(/No run-touched files/i)
  })

  it('git_commit stages via commitPaths when paths are explicit', async () => {
    const result = await executeTool(
      'git_commit',
      JSON.stringify({ message: 'feat: test commit', paths: ['a.ts'] }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(commitPaths).toHaveBeenCalledWith(workspace, 'feat: test commit', false, ['a.ts'])
    expect(result.content).toContain('committed: true')
    expect(result.content).toContain('message: feat: test commit')
  })

  it('git_commit fails without a message', async () => {
    const result = await executeTool(
      'git_commit',
      JSON.stringify({ message: '   ' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(false)
    expect(commitPaths).not.toHaveBeenCalled()
    expect(result.content).toMatch(/message/)
  })

  it('diagnostics formats parsed issues for the UI', async () => {
    const result = await executeTool(
      'diagnostics',
      JSON.stringify({ kind: 'typecheck' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(result.content).toContain('command:')
    expect(result.content).toMatch(/src\/a\.ts:1:1:\s*error/)
  })

  it('browser_tabs list returns manageTabs content', async () => {
    const result = await executeTool(
      'browser_tabs',
      JSON.stringify({ action: 'list' }),
      workspace,
      new AbortController().signal
    )
    expect(result.ok).toBe(true)
    expect(manageTabs).toHaveBeenCalled()
    expect(result.content).toContain('tab-1')
    expect(result.content).toContain('https://example.com/')
  })

  it('browser_navigate / snapshot / click route through agentBrowser', async () => {
    const signal = new AbortController().signal
    const nav = await executeTool(
      'browser_navigate',
      JSON.stringify({ url: 'https://example.com/' }),
      workspace,
      signal
    )
    expect(nav.ok).toBe(true)
    expect(navigateUrl).toHaveBeenCalled()

    const snap = await executeTool('browser_snapshot', '{}', workspace, signal)
    expect(snap.ok).toBe(true)
    expect(snapshotPage).toHaveBeenCalled()
    expect(snap.content).toContain('@e1')

    const click = await executeTool(
      'browser_click',
      JSON.stringify({ selector: '@e1' }),
      workspace,
      signal
    )
    expect(click.ok).toBe(true)
    expect(clickSelector).toHaveBeenCalled()
  })

  it('browser_scroll / fill / type route through agentBrowser', async () => {
    const signal = new AbortController().signal
    const scroll = await executeTool(
      'browser_scroll',
      JSON.stringify({ deltaY: 600 }),
      workspace,
      signal
    )
    expect(scroll.ok).toBe(true)
    expect(scrollPage).toHaveBeenCalled()

    const fill = await executeTool(
      'browser_fill',
      JSON.stringify({ selector: '@e3', value: 'hello' }),
      workspace,
      signal
    )
    expect(fill.ok).toBe(true)
    expect(fillSelector).toHaveBeenCalled()

    const typed = await executeTool(
      'browser_type',
      JSON.stringify({ text: 'world', selector: '@e3', pressEnter: true }),
      workspace,
      signal
    )
    expect(typed.ok).toBe(true)
    expect(typeText).toHaveBeenCalled()
  })

  it('browser_back / forward route through agentBrowser', async () => {
    const signal = new AbortController().signal
    const back = await executeTool('browser_back', '{}', workspace, signal)
    expect(back.ok).toBe(true)
    expect(goBack).toHaveBeenCalled()

    const forward = await executeTool('browser_forward', '{}', workspace, signal)
    expect(forward.ok).toBe(true)
    expect(goForward).toHaveBeenCalled()
  })

  it('browser_wait_for_selector / wait_for_url route through agentBrowser', async () => {
    const signal = new AbortController().signal
    const waitSel = await executeTool(
      'browser_wait_for_selector',
      JSON.stringify({ selector: '#app', timeoutMs: 500 }),
      workspace,
      signal
    )
    expect(waitSel.ok).toBe(true)
    expect(waitForSelector).toHaveBeenCalled()

    const waitUrl = await executeTool(
      'browser_wait_for_url',
      JSON.stringify({ match: '/dashboard', timeoutMs: 500 }),
      workspace,
      signal
    )
    expect(waitUrl.ok).toBe(true)
    expect(waitForUrl).toHaveBeenCalled()
  })

  it('browser_press_key / select_option route through agentBrowser', async () => {
    const signal = new AbortController().signal
    const key = await executeTool(
      'browser_press_key',
      JSON.stringify({ key: 'Enter' }),
      workspace,
      signal
    )
    expect(key.ok).toBe(true)
    expect(pressKey).toHaveBeenCalled()

    const sel = await executeTool(
      'browser_select_option',
      JSON.stringify({ selector: '@e9', value: 'v1' }),
      workspace,
      signal
    )
    expect(sel.ok).toBe(true)
    expect(selectOption).toHaveBeenCalled()
  })

  it('browser_select_option dispatches without a schema gate', async () => {
    const result = await executeTool(
      'browser_select_option',
      JSON.stringify({ selector: '@e9' }),
      workspace,
      new AbortController().signal
    )
    expect(selectOption).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('browser_search goes through executeTool', async () => {
    const signal = new AbortController().signal
    const searched = await executeTool(
      'browser_search',
      JSON.stringify({ query: 'vyotiq agent' }),
      workspace,
      signal
    )
    expect(searched.ok).toBe(true)
    expect(navigateUrl).toHaveBeenCalled()
    expect(snapshotPage).toHaveBeenCalled()
  })
})

describe('executeTool browser action handlers', () => {
  let workspace: string

  beforeEach(() => {
    workspace = mkdtempSync(join(tmpdir(), 'vyotiq-browser-actions-'))
    for (const mock of [
      manageTabs,
      navigateUrl,
      snapshotPage,
      clickSelector,
      typeText,
      scrollPage,
      fillSelector,
      goBack,
      goForward,
      waitForSelector,
      waitForUrl,
      pressKey,
      selectOption
    ]) {
      mock.mockClear()
    }
  })

  afterEach(() => {
    if (workspace && existsSync(workspace)) {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('browser_type maps text/selector/clear/pressEnter/tab_id/settleMs', async () => {
    const result = await executeTool(
      'browser_type',
      JSON.stringify({
        text: 'hello world',
        selector: '@e2',
        clear: true,
        pressEnter: true,
        tab_id: 'tab-2',
        settleMs: 120
      }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('@e2')
    expect(result.content).toBe('typed text')
    expect(typeText).toHaveBeenCalledWith('hello world', {
      signal: expect.any(AbortSignal),
      selector: '@e2',
      clear: true,
      pressEnter: true,
      tabId: 'tab-2',
      settleMs: 120,
      workspacePath: workspace
    })
  })

  it('browser_type defaults to the active element without a selector', async () => {
    const result = await executeTool(
      'browser_type',
      JSON.stringify({ text: 'x' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('active element')
    expect(typeText).toHaveBeenCalledWith('x', {
      signal: expect.any(AbortSignal),
      selector: undefined,
      clear: false,
      pressEnter: false,
      tabId: undefined,
      settleMs: undefined,
      workspacePath: workspace
    })
  })

  it('browser_scroll maps deltas and summarizes them without a selector', async () => {
    const result = await executeTool(
      'browser_scroll',
      JSON.stringify({ deltaX: 10, deltaY: 240, tab_id: 'tab-3', settleMs: 50 }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Δ(10,240)')
    expect(scrollPage).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      selector: undefined,
      deltaX: 10,
      deltaY: 240,
      tabId: 'tab-3',
      settleMs: 50,
      workspacePath: workspace
    })
  })

  it('browser_scroll prefers a selector target when provided', async () => {
    const result = await executeTool(
      'browser_scroll',
      JSON.stringify({ selector: '@e8', deltaY: 100 }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('@e8')
    expect(scrollPage).toHaveBeenCalledWith(
      expect.objectContaining({ selector: '@e8', deltaY: 100 })
    )
  })

  it('browser_fill maps selector/value/pressEnter/tab_id/settleMs', async () => {
    const result = await executeTool(
      'browser_fill',
      JSON.stringify({
        selector: '@e3',
        value: 'new value',
        pressEnter: true,
        tab_id: 'tab-1',
        settleMs: 75
      }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('@e3')
    expect(fillSelector).toHaveBeenCalledWith('@e3', 'new value', {
      signal: expect.any(AbortSignal),
      pressEnter: true,
      tabId: 'tab-1',
      settleMs: 75,
      workspacePath: workspace
    })
  })

  it('browser_back and browser_forward map tab_id', async () => {
    const signal = new AbortController().signal

    const back = await executeTool('browser_back', JSON.stringify({ tab_id: 'tab-7' }), workspace, signal)
    expect(back.ok).toBe(true)
    // Empty summary — toolLabel verb already says "Going back" / "Going forward".
    expect(back.summary).toBe('')
    expect(goBack).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      tabId: 'tab-7',
      workspacePath: workspace,
      allowLocal: true
    })

    const forward = await executeTool('browser_forward', '{}', workspace, signal)
    expect(forward.ok).toBe(true)
    expect(forward.summary).toBe('')
    expect(goForward).toHaveBeenCalledWith({
      signal: expect.any(AbortSignal),
      tabId: undefined,
      workspacePath: workspace,
      allowLocal: true
    })
  })

  it('browser_wait_for_selector maps selector/timeoutMs/tab_id', async () => {
    const result = await executeTool(
      'browser_wait_for_selector',
      JSON.stringify({ selector: '#app', timeoutMs: 500, tab_id: 'tab-4' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('#app')
    expect(waitForSelector).toHaveBeenCalledWith('#app', {
      signal: expect.any(AbortSignal),
      timeoutMs: 500,
      tabId: 'tab-4',
      workspacePath: workspace
    })
  })

  it('browser_wait_for_url maps match/regex/timeoutMs', async () => {
    const result = await executeTool(
      'browser_wait_for_url',
      JSON.stringify({ match: '/dashboard', regex: true, timeoutMs: 900, tab_id: 'tab-5' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(waitForUrl).toHaveBeenCalledWith('/dashboard', {
      signal: expect.any(AbortSignal),
      regex: true,
      timeoutMs: 900,
      tabId: 'tab-5',
      workspacePath: workspace
    })

    const plain = await executeTool(
      'browser_wait_for_url',
      JSON.stringify({ match: 'example.com' }),
      workspace,
      new AbortController().signal
    )
    expect(plain.ok).toBe(true)
    expect(waitForUrl).toHaveBeenLastCalledWith(
      'example.com',
      expect.objectContaining({ regex: false, timeoutMs: undefined, tabId: undefined })
    )
  })

  it('formatWaitTimeoutMessage quotes url, includes title, and omits a null title', async () => {
    const { formatWaitTimeoutMessage } = await import('@main/app/agentBrowser')

    expect(
      formatWaitTimeoutMessage({
        timeoutMs: 10000,
        needle: 'secure',
        regex: true,
        url: 'https://example.com/login',
        title: 'Sign in'
      })
    ).toBe(
      'Timed out after 10000ms waiting for URL matching /secure/ (last: "https://example.com/login", title: "Sign in")'
    )

    expect(
      formatWaitTimeoutMessage({
        timeoutMs: 5000,
        needle: '/dashboard',
        regex: false,
        url: 'https://example.com/home',
        title: null
      })
    ).toBe('Timed out after 5000ms waiting for URL matching "/dashboard" (last: "https://example.com/home")')
  })

  it('browser_press_key maps key/modifiers/tab_id/settleMs', async () => {
    const result = await executeTool(
      'browser_press_key',
      JSON.stringify({ key: 'Enter', modifiers: ['control', 'shift'], tab_id: 'tab-6', settleMs: 30 }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(result.summary).toBe('Enter')
    expect(pressKey).toHaveBeenCalledWith('Enter', {
      signal: expect.any(AbortSignal),
      modifiers: ['control', 'shift'],
      tabId: 'tab-6',
      settleMs: 30,
      workspacePath: workspace
    })
  })

  it('browser_press_key includeSnapshot appends a snapshot like type/fill', async () => {
    const result = await executeTool(
      'browser_press_key',
      JSON.stringify({ key: 'Enter', includeSnapshot: true }),
      workspace,
      new AbortController().signal,
      { runDir: workspace }
    )

    expect(result.ok).toBe(true)
    expect(pressKey).toHaveBeenCalled()
    expect(snapshotPage).toHaveBeenCalledWith(
      expect.objectContaining({
        workspacePath: workspace,
        runDir: workspace
      })
    )
    expect(result.content).toContain('pressed Enter')
    expect(result.content).toContain('refs:')
  })

  it('browser_select_option maps value or label', async () => {
    const byValue = await executeTool(
      'browser_select_option',
      JSON.stringify({ selector: '#sel', value: 'v1', tab_id: 'tab-8' }),
      workspace,
      new AbortController().signal
    )
    expect(byValue.ok).toBe(true)
    expect(selectOption).toHaveBeenCalledWith('#sel', {
      signal: expect.any(AbortSignal),
      value: 'v1',
      label: undefined,
      pressEnter: false,
      tabId: 'tab-8',
      settleMs: undefined,
      workspacePath: workspace
    })

    const byLabel = await executeTool(
      'browser_select_option',
      JSON.stringify({ selector: '#sel', label: 'Choice A', pressEnter: true }),
      workspace,
      new AbortController().signal
    )
    expect(byLabel.ok).toBe(true)
    expect(selectOption).toHaveBeenLastCalledWith(
      '#sel',
      expect.objectContaining({ value: undefined, label: 'Choice A', pressEnter: true })
    )
  })

  it('browser_select_option dispatches without value or label', async () => {
    const result = await executeTool(
      'browser_select_option',
      JSON.stringify({ selector: '#sel' }),
      workspace,
      new AbortController().signal
    )

    expect(selectOption).toHaveBeenCalled()
    expect(result.ok).toBe(true)
  })

  it('browser_click maps button and settleMs', async () => {
    const result = await executeTool(
      'browser_click',
      JSON.stringify({ selector: '@e1', button: 'right', settleMs: 40, tab_id: 'tab-1' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(clickSelector).toHaveBeenCalledWith(
      '@e1',
      expect.objectContaining({
        signal: expect.any(AbortSignal),
        button: 'right',
        tabId: 'tab-1',
        settleMs: 40,
        workspacePath: workspace,
        includeSnapshot: false
      })
    )
  })

  it('browser_tabs rejects an invalid action without touching the browser', async () => {
    const result = await executeTool(
      'browser_tabs',
      JSON.stringify({ action: 'bogus' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(false)
    expect(manageTabs).not.toHaveBeenCalled()
  })

  it('browser_tabs open maps the url arg', async () => {
    const result = await executeTool(
      'browser_tabs',
      JSON.stringify({ action: 'open', url: 'https://example.com/new' }),
      workspace,
      new AbortController().signal
    )

    expect(result.ok).toBe(true)
    expect(manageTabs).toHaveBeenCalledWith('open', {
      signal: expect.any(AbortSignal),
      tabId: undefined,
      url: 'https://example.com/new',
      workspacePath: workspace,
      allowLocal: true
    })
  })

  it('browser_tabs open passes allowLocal=false in Ask mode', async () => {
    const result = await executeTool(
      'browser_tabs',
      JSON.stringify({ action: 'open', url: 'http://localhost:3000' }),
      workspace,
      new AbortController().signal,
      { agentMode: 'ask' }
    )

    expect(result.ok).toBe(true)
    expect(manageTabs).toHaveBeenCalledWith('open', {
      signal: expect.any(AbortSignal),
      tabId: undefined,
      url: 'http://localhost:3000',
      workspacePath: workspace,
      allowLocal: false
    })
  })

  it('denies mutating browser tools in Ask mode but allows the browse-only subset', async () => {
    const signal = new AbortController().signal
    const ask = { agentMode: 'ask' as const }

    for (const [name, args] of [
      ['browser_type', { text: 'x' }],
      ['browser_fill', { selector: '@e1', value: 'x' }],
      ['browser_press_key', { key: 'Enter' }],
      ['browser_select_option', { selector: '#s', value: 'v' }],
      ['browser_click', { selector: '@e1' }]
    ] as const) {
      const denied = await executeTool(name, JSON.stringify(args), workspace, signal, ask)
      expect(denied.ok).toBe(false)
      expect(denied.content).toMatch(/Ask mode does not allow tool/)
    }
    expect(typeText).not.toHaveBeenCalled()
    expect(fillSelector).not.toHaveBeenCalled()
    expect(pressKey).not.toHaveBeenCalled()
    expect(selectOption).not.toHaveBeenCalled()
    expect(clickSelector).not.toHaveBeenCalled()

    for (const [name, args] of [
      ['browser_scroll', { deltaY: 100 }],
      ['browser_back', {}],
      ['browser_forward', {}],
      ['browser_wait_for_selector', { selector: '#app' }],
      ['browser_wait_for_url', { match: 'example.com' }]
    ] as const) {
      const allowed = await executeTool(name, JSON.stringify(args), workspace, signal, ask)
      expect(allowed.ok).toBe(true)
    }
    expect(scrollPage).toHaveBeenCalled()
    expect(goBack).toHaveBeenCalled()
    expect(goForward).toHaveBeenCalled()
    expect(waitForSelector).toHaveBeenCalled()
    expect(waitForUrl).toHaveBeenCalled()
  })

  it('rejects a pre-aborted signal before dispatching to the browser', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(
      executeTool('browser_scroll', JSON.stringify({ deltaY: 100 }), workspace, controller.signal)
    ).rejects.toThrow('Aborted')
    expect(scrollPage).not.toHaveBeenCalled()
  })

  it('rejects with AbortError when the signal aborts while the browser call is in flight', async () => {
    const controller = new AbortController()
    waitForSelector.mockImplementationOnce(async () => {
      controller.abort()
      return 'found late'
    })

    await expect(
      executeTool(
        'browser_wait_for_selector',
        JSON.stringify({ selector: '#app' }),
        workspace,
        controller.signal
      )
    ).rejects.toThrow('Aborted')
    expect(waitForSelector).toHaveBeenCalled()
  })
})
