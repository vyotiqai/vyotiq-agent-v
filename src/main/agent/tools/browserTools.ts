import { buildSearchUrl } from '../../../shared/utils/searchEngine'
import type { AgentToolName } from '../schemas/tools'
import {
  navigateUrl,
  snapshotPage,
  clickSelector,
  typeText,
  scrollPage,
  fillSelector,
  manageTabs,
  goBack,
  goForward,
  waitForSelector,
  waitForUrl,
  pressKey,
  selectOption,
  hoverSelector,
  waitForText,
  handleDialog
} from '@main/app/agentBrowser'
import { getSettings } from '@main/settings/settings'
import { readTrimmed } from './argAccess'
import { throwIfAborted, toolOk, toolFail, resolveAgentMode } from './index'
import type { ToolHandler } from './index'

export const browserHandlers = {
  browser_search: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const query = readTrimmed(args, 'query')
    if (!query) throw new Error('browser_search requires query')
    // Invoke-snapshotted settings when present — avoid mid-run searchEngine drift.
    const settings = context.invokeSettings ?? getSettings()
    const url = buildSearchUrl(settings.searchEngine, query)
    const timeoutMs = typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined
    const allowLocal = resolveAgentMode(context) === 'agent'
    const nav = await navigateUrl(url, {
      signal,
      timeoutMs,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    const snap = await snapshotPage({
      signal,
      workspacePath: workspace,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
    })
    throwIfAborted(signal)
    return toolOk('browser_search', query, `${nav}\n\n${snap}`)
  },
  browser_navigate: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const url = args.url as string
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await navigateUrl(url, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_navigate', url, content)
  },
  browser_snapshot: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const content = await snapshotPage({
      signal,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      runDir: context.runDir,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_snapshot', 'page', content)
  },
  browser_click: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const button =
      args.button === 'left' || args.button === 'right' || args.button === 'middle'
        ? args.button
        : undefined
    const content = await clickSelector(selector, {
      signal,
      button,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace,
      includeSnapshot: args.includeSnapshot === true,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined
    })
    throwIfAborted(signal)
    return toolOk('browser_click', selector, content)
  },
  browser_type: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const text = args.text as string
    let content = await typeText(text, {
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      clear: args.clear === true,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : 'active element'
    return toolOk('browser_type', target, content)
  },
  browser_scroll: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    let content = await scrollPage({
      signal,
      selector: typeof args.selector === 'string' ? args.selector : undefined,
      deltaX: typeof args.deltaX === 'number' ? args.deltaX : undefined,
      deltaY: typeof args.deltaY === 'number' ? args.deltaY : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : `Δ(${Number(args.deltaX) || 0},${Number(args.deltaY) || 0})`
    return toolOk('browser_scroll', target, content)
  },
  browser_fill: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const value = args.value as string
    let content = await fillSelector(selector, value, {
      signal,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_fill', selector, content)
  },
  browser_tabs: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const action = args.action
    if (action !== 'list' && action !== 'open' && action !== 'close' && action !== 'select') {
      return toolFail('browser_tabs', 'tabs', 'action must be list|open|close|select')
    }
    // Same Ask/Plan SSRF gate as browser_navigate — open must not default allowLocal=true.
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await manageTabs(action, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      url: typeof args.url === 'string' ? args.url : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_tabs', action, content)
  },
  browser_back: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await goBack({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    // Empty summary — "back"/"forward" duplicated the verb ("Going back back").
    return toolOk('browser_back', '', content)
  },
  browser_forward: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const allowLocal = resolveAgentMode(context) === 'agent'
    const content = await goForward({
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      allowLocal
    })
    throwIfAborted(signal)
    return toolOk('browser_forward', '', content)
  },
  browser_wait_for_selector: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const content = await waitForSelector(selector, {
      signal,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_selector', selector, content)
  },
  browser_wait_for_url: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const match = args.match as string
    const content = await waitForUrl(match, {
      signal,
      regex: args.regex === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_url', match.slice(0, 80), content)
  },
  browser_press_key: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const key = args.key as string
    const modifiers = Array.isArray(args.modifiers)
      ? args.modifiers.filter((m): m is string => typeof m === 'string')
      : undefined
    let content = await pressKey(key, {
      signal,
      modifiers,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_press_key', key, content)
  },
  browser_select_option: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    let content = await selectOption(selector, {
      signal,
      value: typeof args.value === 'string' ? args.value : undefined,
      label: typeof args.label === 'string' ? args.label : undefined,
      pressEnter: args.pressEnter === true,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace
    })
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_select_option', selector, content)
  },
  browser_hover: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const selector = args.selector as string
    const content = await hoverSelector(selector, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace,
      includeSnapshot: args.includeSnapshot === true,
      runDir: context.runDir
    })
    throwIfAborted(signal)
    return toolOk('browser_hover', selector, content)
  },
  browser_wait_for_text: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const text = args.text as string
    const content = await waitForText(text, {
      signal,
      regex: args.regex === true,
      timeoutMs: typeof args.timeoutMs === 'number' ? args.timeoutMs : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_wait_for_text', text.slice(0, 80), content)
  },
  browser_handle_dialog: async (workspace, args, signal) => {
    throwIfAborted(signal)
    const action = args.action
    if (action !== 'accept' && action !== 'dismiss') {
      return toolFail('browser_handle_dialog', 'dialog', 'action must be accept|dismiss')
    }
    const content = await handleDialog(action, {
      signal,
      promptText: typeof args.promptText === 'string' ? args.promptText : undefined,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace
    })
    throwIfAborted(signal)
    return toolOk('browser_handle_dialog', action, content)
  }
} satisfies Partial<Record<AgentToolName, ToolHandler>>
