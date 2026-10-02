import { buildSearchUrl } from '../../../shared/utils/searchEngine'
import type { ToolImageRef } from '../../../shared/ipc'
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
  handleDialog,
  type BrowserCaptureTarget
} from '@main/app/agentBrowser'
import { getSettings } from '@main/settings/settings'
import { currentEgressSeq, listEgress } from '@main/net/egress'
import { readTrimmed } from './argAccess'
import { throwIfAborted, toolOk, toolFail, resolveAgentMode } from './index'
import type { ToolHandler } from './index'

/** Origins named in a refusal note before it summarizes the rest. */
const REFUSAL_NOTE_MAX_ORIGINS = 5

/**
 * Describe refusals the egress gate made while a browser op ran.
 *
 * Navigation refusals already surface: they throw, and the message names the
 * allowlist. Subresource refusals do not — the page loads, its XHRs are
 * cancelled, and the agent sees something that merely looks broken. It then
 * retries, or reports the site as down, while the one fact that explains the
 * page sits in a ledger nothing reads mid-run. A policy control that fails
 * silently is worse than one that refuses loudly.
 */
export function egressRefusalNote(workspace: string | undefined, sinceSeq: number): string {
  const denied = listEgress({ deniedOnly: true }).filter(
    (entry) =>
      entry.seq > sinceSeq &&
      // Entries recorded without a workspace cannot be excluded on that basis.
      (!entry.workspacePath || !workspace || entry.workspacePath === workspace)
  )
  // Private-network refusals of a page's own navigation (a link, a redirect, a
  // popup) are silent too — the tab just stays put — so they are reported
  // alongside subresources. Other navigation refusals throw and need no note.
  const privateNetwork = denied.filter((entry) => entry.reason === 'private_network')
  const policy = denied.filter(
    (entry) => entry.purpose === 'browser_subresource' && entry.reason !== 'private_network'
  )

  const notes: string[] = []
  if (policy.length > 0) {
    notes.push(
      `[egress policy] Refused ${policy.length} request(s) from this page to: ` +
        `${originSummary(policy)}. The page may be incomplete. This is the host ` +
        `allowlist refusing the request, not the site failing.`
    )
  }
  if (privateNetwork.length > 0) {
    notes.push(
      `[egress policy] Refused ${privateNetwork.length} request(s) from a public page into ` +
        `loopback/private network space: ${originSummary(privateNetwork)}. Only a local ` +
        `page may reach local hosts; to open one, navigate to it directly with browser_navigate.`
    )
  }
  return notes.join('\n')
}

function originSummary(entries: readonly { origin: string }[]): string {
  const byOrigin = new Map<string, number>()
  for (const entry of entries) {
    byOrigin.set(entry.origin, (byOrigin.get(entry.origin) ?? 0) + 1)
  }
  const ranked = [...byOrigin.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const shown = ranked
    .slice(0, REFUSAL_NOTE_MAX_ORIGINS)
    .map(([origin, count]) => (count > 1 ? `${origin} (${count})` : origin))
  const rest = ranked.length - shown.length
  return `${shown.join(', ')}${rest > 0 ? `, and ${rest} more` : ''}`
}

/**
 * Append the note to every browser tool result, so no handler can forget it.
 * Only successful results are annotated: when the op itself failed, the thrown
 * message already explains why.
 */
function withEgressNotes<T extends Partial<Record<AgentToolName, ToolHandler>>>(handlers: T): T {
  const wrapped: Partial<Record<AgentToolName, ToolHandler>> = {}
  for (const [name, handler] of Object.entries(handlers) as [AgentToolName, ToolHandler][]) {
    wrapped[name] = async (workspace, args, signal, context) => {
      const sinceSeq = currentEgressSeq()
      const result = await handler(workspace, args, signal, context)
      if (!result.ok) return result
      const note = egressRefusalNote(workspace, sinceSeq)
      return note ? { ...result, content: `${result.content}\n\n${note}` } : result
    }
  }
  return wrapped as T
}

/** Snip target from browser_snapshot args; the schema already refuses both at once. */
function captureTargetFromArgs(args: Record<string, unknown>): BrowserCaptureTarget {
  if (typeof args.clip === 'string' && args.clip.trim()) {
    return { kind: 'element', selector: args.clip.trim() }
  }
  const region = args.region as Record<string, unknown> | undefined
  if (
    region &&
    typeof region.x === 'number' &&
    typeof region.y === 'number' &&
    typeof region.width === 'number' &&
    typeof region.height === 'number'
  ) {
    return { kind: 'region', x: region.x, y: region.y, width: region.width, height: region.height }
  }
  return { kind: 'viewport' }
}

const rawBrowserHandlers = {
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
    const captures: ToolImageRef[] = []
    const snap = await snapshotPage({
      signal,
      workspacePath: workspace,
      runDir: context.runDir,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      captures
    })
    throwIfAborted(signal)
    return toolOk('browser_search', query, `${nav}\n\n${snap}`, captures)
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
    const captures: ToolImageRef[] = []
    const capture = captureTargetFromArgs(args)
    const content = await snapshotPage({
      signal,
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      runDir: context.runDir,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      workspacePath: workspace,
      screenshot: args.screenshot !== false,
      capture,
      frames: typeof args.frames === 'number' ? args.frames : undefined,
      intervalMs: typeof args.intervalMs === 'number' ? args.intervalMs : undefined,
      captures
    })
    throwIfAborted(signal)
    const summary =
      capture.kind === 'element' ? capture.selector : capture.kind === 'region' ? 'region' : 'page'
    return toolOk('browser_snapshot', summary, content, captures)
  },
  browser_click: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const captures: ToolImageRef[] = []
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
      maxChars: typeof args.maxChars === 'number' ? args.maxChars : undefined,
      captures
    })
    throwIfAborted(signal)
    return toolOk('browser_click', selector, content, captures)
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
    const captures: ToolImageRef[] = []
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
        captures
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : 'active element'
    return toolOk('browser_type', target, content, captures)
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
    const captures: ToolImageRef[] = []
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
        captures
      })}`
    }
    throwIfAborted(signal)
    const target =
      typeof args.selector === 'string' && args.selector.trim()
        ? args.selector.trim()
        : `Δ(${Number(args.deltaX) || 0},${Number(args.deltaY) || 0})`
    return toolOk('browser_scroll', target, content, captures)
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
    const captures: ToolImageRef[] = []
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
        captures
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_fill', selector, content, captures)
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
    const captures: ToolImageRef[] = []
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
        captures
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_press_key', key, content, captures)
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
    const captures: ToolImageRef[] = []
    if (args.includeSnapshot === true) {
      content = `${content}\n\n${await snapshotPage({
        signal,
        workspacePath: workspace,
        runDir: context.runDir,
        tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
        captures
      })}`
    }
    throwIfAborted(signal)
    return toolOk('browser_select_option', selector, content, captures)
  },
  browser_hover: async (workspace, args, signal, context) => {
    throwIfAborted(signal)
    const captures: ToolImageRef[] = []
    const selector = args.selector as string
    const content = await hoverSelector(selector, {
      signal,
      tabId: typeof args.tab_id === 'string' ? args.tab_id : undefined,
      settleMs: typeof args.settleMs === 'number' ? args.settleMs : undefined,
      workspacePath: workspace,
      includeSnapshot: args.includeSnapshot === true,
      runDir: context.runDir,
      captures
    })
    throwIfAborted(signal)
    return toolOk('browser_hover', selector, content, captures)
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

export const browserHandlers = withEgressNotes(rawBrowserHandlers)
