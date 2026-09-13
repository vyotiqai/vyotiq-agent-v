import type { UiToolRow } from '@shared/transcript'
import { parseArgsRecord } from '@shared/toolSummary'

export type BrowserRef = {
  id: string
  role: string
  name: string
  css: string
}

export type BrowserSnapshotParsed = {
  url: string
  title: string
  tabId: string
  viewport: string
  refs: BrowserRef[]
  body: string
  screenshotNote: string
  /** Relative run artifact path e.g. browser/snapshot-….jpg */
  screenshotPath: string
  message: string
}

export type BrowserTabRow = {
  id: string
  title: string
  url: string
}

export type BrowserTabsParsed = {
  action: string
  tabs: BrowserTabRow[]
  message: string
}

export type BrowserActionParsed = {
  target: string
  tabId: string
  message: string
  failed: boolean
}

function headerValue(content: string, key: string): string {
  const re = new RegExp(`^${key}:\\s*(.+)$`, 'im')
  const m = re.exec(content)
  return m?.[1]?.trim() || ''
}

/** Parse browser_snapshot content from agentBrowser.takeSnapshot. */
export function parseBrowserSnapshotData(tool: UiToolRow): BrowserSnapshotParsed {
  const content = tool.content ?? ''
  if (!content.trim()) {
    return {
      url: '',
      title: '',
      tabId: '',
      viewport: '',
      refs: [],
      body: '',
      screenshotNote: '',
      screenshotPath: '',
      message: ''
    }
  }

  // Prefer snapshot headers (`URL:`). browser_search prefixes a navigate preamble.
  const url =
    headerValue(content, 'URL') ||
    (/^Navigated to\s+(\S+)/im.exec(content)?.[1] ?? '')
  const title = headerValue(content, 'Title')
  const tabId = headerValue(content, 'tab_id')
  const viewport = headerValue(content, 'Viewport')
  const navLine = /^Navigated to\s+.+$/im.exec(content)?.[0]?.trim() ?? ''

  const screenshotMatch = content.match(/\[Screenshot (?:saved|capture failed)[^\]]*\]/i)
  const screenshotNote = screenshotMatch?.[0] ?? ''
  const captureFailed = /capture failed/i.test(screenshotNote)
  const pathFromNote =
    /run\s+(browser\/snapshot(?:-[\w.-]+)?\.jpg)/i.exec(screenshotNote)?.[1] ??
    (screenshotNote && !captureFailed ? 'browser/snapshot.jpg' : '')

  const refs: BrowserRef[] = []
  const newRefRe =
    /^-\s+@(e\d+)\s+role=("(?:\\.|[^"\\])*"|""|\S+)\s+name=("(?:\\.|[^"\\])*"|""|\S+)\s+css=("(?:\\.|[^"\\])*"|""|\S+)\s*$/gm
  const oldRefRe =
    /^-\s+@(e\d+)\s+(\S+)\s+("(?:\\.|[^"\\])*"|""|\S+)\s+css=("(?:\\.|[^"\\])*"|""|\S+)\s*$/gm
  // Older browser snapshots omitted the leading dash and key/value labels:
  // `@e1 link Skip to main content`. Keep that payload structured instead of
  // sending the complete accessibility dump through the raw-text fallback.
  const legacyRefRe = /^@(e\d+)\s+(\S+)(?:\s+(.+?))?\s*$/gm
  const parseQuoted = (value: string): string => {
    try {
      if (value.startsWith('"')) return JSON.parse(value) as string
    } catch {
      return value.replace(/^"|"$/g, '')
    }
    return value
  }
  let m: RegExpExecArray | null
  while ((m = newRefRe.exec(content)) !== null) {
    refs.push({
      id: m[1]!,
      role: parseQuoted(m[2]!),
      name: parseQuoted(m[3]!),
      css: parseQuoted(m[4]!)
    })
  }
  if (refs.length === 0) {
    while ((m = oldRefRe.exec(content)) !== null) {
      refs.push({
        id: m[1]!,
        role: m[2]!,
        name: parseQuoted(m[3]!),
        css: parseQuoted(m[4]!)
      })
    }
  }
  if (refs.length === 0) {
    while ((m = legacyRefRe.exec(content)) !== null) {
      refs.push({
        id: m[1]!,
        role: m[2]!,
        name: m[3]?.trim() ?? '',
        css: ''
      })
    }
  }

  let body = ''
  const interactiveIdx = content.search(/^Interactive elements/im)
  if (interactiveIdx >= 0) {
    const afterInteractive = content.slice(interactiveIdx)
    const blankAfterRefs = afterInteractive.search(/\n\n/)
    if (blankAfterRefs >= 0) {
      body = afterInteractive
        .slice(blankAfterRefs + 2)
        .replace(/\n?\[Screenshot saved[^\]]*\]\s*$/i, '')
        .trim()
    }
  }
  if (!body) {
    const legacyRefLine = /^@e\d+\s+\S+(?:\s+.+)?\s*$/i
    body = content
      .split(/\r?\n/)
      .filter((line) => {
        const trimmed = line.trim()
        if (!trimmed) return true
        if (legacyRefLine.test(trimmed)) return false
        if (/^(?:URL|Title|tab_id|Viewport):\s*/i.test(trimmed)) return false
        if (/^Navigated to\s+/i.test(trimmed)) return false
        if (/^Interactive elements\b/i.test(trimmed)) return false
        if (/^Showing truncated preview\.?$/i.test(trimmed)) return false
        if (/^\w+\s+\d+\s+refs?$/i.test(trimmed)) return false
        if (/^\[Screenshot (?:saved|capture failed)\b/i.test(trimmed)) return false
        return true
      })
      .join('\n')
      .trim()
  }

  const structured = refs.length > 0 || Boolean(body) || Boolean(url)
  return {
    url,
    title: title === '(none)' ? '' : title,
    tabId,
    viewport: viewport === '(unknown)' ? '' : viewport,
    refs,
    body,
    screenshotNote,
    screenshotPath: pathFromNote,
    // Keep navigate preamble when present; otherwise fall back to raw content if unstructured.
    message: structured ? navLine : content.trim()
  }
}

/** Parse browser_tabs list / status content. */
export function parseBrowserTabsData(tool: UiToolRow): BrowserTabsParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const action = typeof args?.action === 'string' ? args.action : 'list'
  const content = (tool.content ?? '').trim()
  const tabs: BrowserTabRow[] = []

  for (const line of content.split(/\r?\n/)) {
    // Prefer tab-delimited rows from manageTabs list; fall back to legacy "  " split.
    const tabParts = line.match(/^[*\s]\s+(\S+)\t(.*)\t(\S.*)$/)
    if (tabParts) {
      tabs.push({ id: tabParts[1]!, title: tabParts[2]!.trim(), url: tabParts[3]!.trim() })
      continue
    }
    // Greedy title so the last `\s{2,}` before the URL wins (titles may contain "  ").
    const m = line.match(/^[*\s]\s+(\S+)\s{2,}(.+)\s{2,}(\S.*)$/)
    if (!m) continue
    tabs.push({ id: m[1]!, title: m[2]!.trim(), url: m[3]!.trim() })
  }

  return {
    action,
    tabs,
    message: tabs.length === 0 ? content : ''
  }
}

/** Parse short browser action tools (navigate, click, type, …). */
export function parseBrowserActionData(tool: UiToolRow): BrowserActionParsed {
  const args = parseArgsRecord(tool.argsPreview)
  const message = (tool.content ?? '').trim()
  let target = ''
  if (typeof args?.url === 'string' && args.url.trim()) target = args.url.trim()
  else if (typeof args?.query === 'string' && args.query.trim()) target = args.query.trim()
  else if (typeof args?.match === 'string' && args.match.trim()) target = args.match.trim()
  else if (typeof args?.selector === 'string' && args.selector.trim()) target = args.selector.trim()
  else if (typeof args?.ref === 'string' && args.ref.trim()) target = args.ref.trim()
  else if (typeof args?.key === 'string' && args.key.trim()) target = args.key.trim()
  else if (typeof args?.text === 'string' && args.text.trim()) {
    target = args.text.trim().slice(0, 48)
  } else if (tool.summary?.trim()) {
    target = tool.summary.trim()
  }
  const tabFromArgs = typeof args?.tab_id === 'string' ? args.tab_id.trim() : ''
  const tabFromContent = /^tab_id:\s*(\S+)/im.exec(message)?.[1] ?? ''
  const failed =
    tool.status === 'fail' ||
    /timed out|failed|unknown snapshot ref|not interactable|ssrf|blocked|ERR_|CONNECTION_REFUSED/i.test(
      message
    )
  return {
    target,
    tabId: tabFromArgs || tabFromContent,
    message,
    failed
  }
}
