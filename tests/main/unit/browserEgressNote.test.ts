import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/ipc'

vi.mock('@main/app/agentBrowser', () => ({
  navigateUrl: vi.fn(async () => 'navigated'),
  snapshotPage: vi.fn(async () => 'snapshot body'),
  clickSelector: vi.fn(async () => 'clicked'),
  typeText: vi.fn(async () => 'typed'),
  scrollPage: vi.fn(async () => 'scrolled'),
  fillSelector: vi.fn(async () => 'filled'),
  manageTabs: vi.fn(async () => 'tabs'),
  goBack: vi.fn(async () => 'back'),
  goForward: vi.fn(async () => 'forward'),
  waitForSelector: vi.fn(async () => 'waited'),
  waitForUrl: vi.fn(async () => 'waited'),
  pressKey: vi.fn(async () => 'pressed'),
  selectOption: vi.fn(async () => 'selected'),
  hoverSelector: vi.fn(async () => 'hovered'),
  waitForText: vi.fn(async () => 'waited'),
  handleDialog: vi.fn(async () => 'handled')
}))

vi.mock('@main/settings/settings', () => ({
  getSettings: vi.fn(() => ({ ...DEFAULT_SETTINGS }))
}))

import { navigateUrl } from '@main/app/agentBrowser'
import { browserHandlers, egressRefusalNote } from '@main/agent/tools/browserTools'
import { checkEgress, clearEgressLedger } from '@main/net/egress'

const WS = '/ws'
const ALLOWLIST = ['example.com']

function refuse(origin: string, count = 1): void {
  for (let i = 0; i < count; i += 1) {
    checkEgress({
      url: `${origin}/collect`,
      purpose: 'browser_subresource',
      workspacePath: WS,
      allowlist: ALLOWLIST
    })
  }
}

async function navigate(): Promise<{ ok: boolean; content: string }> {
  const result = await browserHandlers.browser_navigate!(
    WS,
    { url: 'https://example.com/page' },
    new AbortController().signal,
    { agentMode: 'agent' }
  )
  return { ok: result.ok, content: result.content }
}

describe('egressRefusalNote', () => {
  beforeEach(() => {
    clearEgressLedger()
  })

  afterEach(() => {
    clearEgressLedger()
    vi.mocked(navigateUrl).mockImplementation(async () => 'navigated')
  })

  it('says nothing when nothing was refused', () => {
    checkEgress({ url: 'https://example.com/ok', purpose: 'browser_subresource', allowlist: ALLOWLIST })
    expect(egressRefusalNote(WS, 0)).toBe('')
  })

  it('names the origins, counts repeats, and blames policy rather than the site', () => {
    refuse('https://tracker.example', 3)
    refuse('https://ads.example', 1)

    const note = egressRefusalNote(WS, 0)
    expect(note).toContain('Refused 4 request(s)')
    expect(note).toContain('https://tracker.example (3)')
    expect(note).toContain('https://ads.example')
    expect(note).not.toContain('https://ads.example (1)')
    expect(note).toContain('not the site failing')
  })

  it('ignores refusals recorded before the op started', () => {
    refuse('https://tracker.example')
    const since = Date.now() + 1000
    expect(egressRefusalNote(WS, since)).toBe('')
  })

  it('ignores navigation refusals, which already surface as thrown errors', () => {
    checkEgress({
      url: 'https://evil.com/page',
      purpose: 'browser_navigation',
      workspacePath: WS,
      allowlist: ALLOWLIST
    })
    expect(egressRefusalNote(WS, 0)).toBe('')
  })

  it('ignores refusals belonging to another workspace', () => {
    checkEgress({
      url: 'https://tracker.example/x',
      purpose: 'browser_subresource',
      workspacePath: '/other-ws',
      allowlist: ALLOWLIST
    })
    expect(egressRefusalNote(WS, 0)).toBe('')
  })

  it('summarizes the tail once past five origins', () => {
    for (let i = 0; i < 8; i += 1) refuse(`https://host-${i}.example`)
    const note = egressRefusalNote(WS, 0)
    expect(note).toContain('and 3 more')
  })
})

describe('browser handlers carry the refusal note', () => {
  beforeEach(() => {
    clearEgressLedger()
  })

  afterEach(() => {
    clearEgressLedger()
    vi.mocked(navigateUrl).mockImplementation(async () => 'navigated')
  })

  it('appends the note when the page had requests refused while it loaded', async () => {
    vi.mocked(navigateUrl).mockImplementation(async () => {
      refuse('https://tracker.example', 2)
      return 'navigated'
    })

    const result = await navigate()
    expect(result.ok).toBe(true)
    expect(result.content).toContain('navigated')
    expect(result.content).toContain('[egress policy] Refused 2 request(s)')
    expect(result.content).toContain('https://tracker.example (2)')
  })

  it('leaves the result untouched when nothing was refused', async () => {
    const result = await navigate()
    expect(result.content).toBe('navigated')
  })

  it('does not report refusals that happened before the call', async () => {
    refuse('https://tracker.example')
    const result = await navigate()
    expect(result.content).toBe('navigated')
  })
})
