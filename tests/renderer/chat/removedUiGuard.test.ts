import { describe, expect, it } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'fs'
import { join } from 'path'

/**
 * Removal guard — these chat UI features were deliberately deleted and must
 * never come back: the agent session tab strip and the git-status start-work
 * chip. Any session that restores, re-creates, or re-imports them fails here.
 * See AGENTS.md → "Removed UI — never restore" before touching chat surfaces.
 */

const REPO = process.cwd()
const GUARD_TEST = join('tests', 'renderer', 'chat', 'removedUiGuard.test.ts')

const FORBIDDEN_FILES = [
  join('src', 'renderer', 'src', 'features', 'chat', 'components', 'AgentSessionBar.tsx'),
  join('src', 'renderer', 'src', 'features', 'chat', 'components', 'ChatStartWork.tsx'),
  join('src', 'renderer', 'src', 'features', 'chat', 'utils', 'chatStartWork.ts'),
  join('tests', 'renderer', 'chat', 'chatStartWork.test.tsx'),
  join('tests', 'renderer', 'chat', 'chatView.sessionTabs.test.tsx')
]

const FORBIDDEN_SYMBOLS = [
  'AgentSessionBar',
  'AgentSessionTab',
  'ChatStartWork',
  'chatStartWork',
  'formatStartWork',
  'data-chat-start-work',
  'data-chat-session-tabs',
  'data-agent-session-bar',
  'agentSessionBarHost',
  'showAgentSessionChrome',
  'agentSessionTabs'
] as const

const SCAN_ROOTS = [join('src', 'renderer', 'src'), join('tests')] as const
const SCAN_EXTENSIONS = new Set(['.ts', '.tsx'])

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walk(full))
    } else if (SCAN_EXTENSIONS.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      out.push(full)
    }
  }
  return out
}

describe('removed UI stays removed', () => {
  it('does not resurrect deleted session-tab / start-work files', () => {
    for (const rel of FORBIDDEN_FILES) {
      expect(
        existsSync(join(REPO, rel)),
        `${rel} was restored — this feature was deliberately removed (see AGENTS.md "Removed UI — never restore") and must stay removed. Fix forward instead.`
      ).toBe(false)
    }
  })

  it('does not reference removed session-tab / start-work symbols in any source or test', () => {
    const offenders: string[] = []
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(REPO, root))) {
        if (file === join(REPO, GUARD_TEST)) continue
        const text = readFileSync(file, 'utf8')
        for (const symbol of FORBIDDEN_SYMBOLS) {
          if (text.includes(symbol)) offenders.push(`${file}: ${symbol}`)
        }
      }
    }
    expect(
      offenders,
      `removed-UI symbols reappeared (see AGENTS.md "Removed UI — never restore"): ${offenders.join(', ')}`
    ).toEqual([])
  })

  it('does not re-wire removed session-tab props into ChatView', () => {
    const chatView = readFileSync(
      join(REPO, 'src', 'renderer', 'src', 'features', 'chat', 'ChatView.tsx'),
      'utf8'
    )
    for (const token of ['onOpenRunTab', 'onCloseRunTab', 'openRunIds', 'RunSummary']) {
      expect(
        chatView.includes(token),
        `ChatView.tsx re-references removed session-tab prop "${token}" — see AGENTS.md "Removed UI — never restore".`
      ).toBe(false)
    }
  })
})
