/**
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createPortal } from 'react-dom'
import { useLayoutEffect, useRef, useState } from 'react'
import { ChangesPanel } from '@renderer/features/chat/components/ChangesPanel'
import { DockTabBar, defaultDockTab } from '@renderer/features/chat/components/DockTabBar'
import { TerminalSessionBar } from '@renderer/features/chat/components/TerminalSessionBar'
import { checksPassedCount, PrPanel } from '@renderer/features/chat/components/PrPanel'

beforeEach(() => {
  Object.defineProperty(window, 'vyotiq', {
    configurable: true,
    writable: true,
    value: {
      gitStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          kind: 'ok',
          status: {
          branch: 'main',
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 3,
              removed: 1,
              addedStaged: 2,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 1,
              binary: false,
              staged: true,
              unstaged: true
            },
            {
              path: 'gone.ts',
              status: 'deleted',
              added: 0,
              removed: 4,
              addedStaged: 0,
              removedStaged: 4,
              addedUnstaged: 0,
              removedUnstaged: 0,
              binary: false,
              staged: true,
              unstaged: false
            },
            {
              path: 'new.ts',
              status: 'untracked',
              added: 2,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 2,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: true
            }
          ],
          truncated: false,
          fileCount: 3,
          added: 5,
          removed: 5,
          hasRemote: true,
          hasCommits: true
          }
        }
      }),
      gitGenerateCommitMessage: vi.fn().mockResolvedValue({
        ok: true,
        data: { message: 'feat: improve generated commit messages', source: 'agent' }
      }),
      gitCommit: vi.fn().mockResolvedValue({
        ok: true,
        data: { committed: true, pushed: true, detail: 'pushed' }
      }),
      gitStageAll: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged all changes' }
      }),
      gitStagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { staged: true, detail: 'Staged path' }
      }),
      gitUnstagePaths: vi.fn().mockResolvedValue({
        ok: true,
        data: { unstaged: true, detail: 'Unstaged path' }
      }),
      gitBranches: vi.fn().mockResolvedValue({
        ok: true,
        data: [{ name: 'main', current: true }]
      }),
      gitCheckout: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'Checked out main' } }),
      gitLog: vi.fn().mockResolvedValue({
        ok: true,
        data: [
          {
            sha: 'abc1234567890',
            shortSha: 'abc1234',
            subject: 'first',
            author: 'dev',
            relativeDate: '1 day ago'
          }
        ]
      }),
      gitCommitFiles: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          files: [
            {
              path: 'src/a.ts',
              status: 'modified',
              added: 1,
              removed: 0,
              addedStaged: 0,
              removedStaged: 0,
              addedUnstaged: 1,
              removedUnstaged: 0,
              binary: false,
              staged: false,
              unstaged: false
            }
          ]
        }
      }),
      gitDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prView: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          number: 10,
          title: 'feat: panels',
          url: 'https://github.com/ex/repo/pull/10',
          state: 'OPEN',
          baseRefName: 'main',
          headRefName: 'feat/panels',
          baseRefOid: 'aaa',
          headRefOid: 'bbb',
          body: 'Hello',
          additions: 10,
          deletions: 2,
          files: [{ path: 'a.ts', additions: 10, deletions: 2, changeType: 'MODIFIED' }],
          commits: [{ oid: 'abc1234', messageHeadline: 'feat', authors: ['dev'] }],
          checks: [{ name: 'ci', state: 'SUCCESS', conclusion: 'SUCCESS' }],
          reviews: [],
          latestReviews: [],
          reviewDecision: '',
          reviewRequests: [],
          isDraft: false
        }
      }),
      prCreate: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          url: 'https://github.com/ex/repo/pull/11',
          branch: 'vyotiq/changes-abc',
          baseBranch: 'main',
          draft: true,
          detail: 'Draft pull request created'
        }
      }),
      prMerge: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'merged' } }),
      prDiff: vi.fn().mockResolvedValue({
        ok: true,
        data: { content: '@@ -1 +1 @@\n-old\n+new\n' }
      }),
      prClose: vi.fn().mockResolvedValue({ ok: true, data: { detail: 'closed' } }),
      prEditTitle: vi.fn().mockResolvedValue({ ok: true, data: { title: 'feat: panels' } }),
      githubAuthStatus: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          ghAvailable: true,
          ghAuthenticated: true,
          hasAppToken: false,
          pending: false,
          userCode: null,
          verificationUri: null,
          error: null
        }
      }),
      githubAuthStart: vi.fn(),
      githubAuthCancel: vi.fn(),
      githubAuthLogout: vi.fn(),
      onGithubAuthStatus: vi.fn(() => () => {}),
      githubCliInstall: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          installed: true,
          detail: 'GitHub CLI installed with winget.',
          ghAvailable: true
        }
      }),
      shellOpenExternal: vi.fn().mockResolvedValue({ ok: true, data: true })
    }
  })
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})
describe('DockTabBar', () => {
  it('selects tabs and opens missing panels from quick launch icons', () => {
    const onSelect = vi.fn()
    const onOpenPanel = vi.fn()
    const onCloseTab = vi.fn()
    const onToggleExpanded = vi.fn()
    render(
      <DockTabBar
        active="changes"
        tabs={[defaultDockTab('changes'), defaultDockTab('terminal')]}
        onSelect={onSelect}
        onCloseTab={onCloseTab}
        onOpenPanel={onOpenPanel}
        expanded={false}
        onToggleExpanded={onToggleExpanded}
      />
    )
    fireEvent.click(screen.getByRole('tab', { name: /^Terminal$/i }))
    expect(onSelect).toHaveBeenCalledWith('terminal')
    fireEvent.click(screen.getByRole('button', { name: /Show browser panel/i }))
    expect(onOpenPanel).toHaveBeenCalledWith('browser')
    fireEvent.click(screen.getByRole('button', { name: /Close Changes/i }))
    expect(onCloseTab).toHaveBeenCalledWith('changes')
    fireEvent.click(screen.getByRole('button', { name: /Expand panel/i }))
    expect(onToggleExpanded).toHaveBeenCalled()
  })

  it('offers a More panels overflow menu when quick launch width is constrained', async () => {
    const Original = global.ResizeObserver
    class NarrowResizeObserver {
      private readonly callback: ResizeObserverCallback
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback
      }
      observe(target: Element): void {
        Object.defineProperty(target, 'clientWidth', {
          configurable: true,
          value: 40
        })
        this.callback([], this as unknown as ResizeObserver)
      }
      unobserve(): void {}
      disconnect(): void {}
    }
    global.ResizeObserver = NarrowResizeObserver as typeof ResizeObserver

    try {
      const onOpenPanel = vi.fn()
      render(
        <DockTabBar
          active="terminal"
          tabs={[]}
          onSelect={vi.fn()}
          onCloseTab={vi.fn()}
          onOpenPanel={onOpenPanel}
          expanded={false}
          onToggleExpanded={vi.fn()}
          embeddedInTitleBar
        />
      )

      const more = await screen.findByRole('button', { name: /More panels/i })
      expect(more).toBeTruthy()
      expect(screen.queryByRole('button', { name: /Show files panel/i })).toBeNull()

      fireEvent.click(more)
      fireEvent.click(await screen.findByRole('menuitem', { name: /^Files$/i }))
      expect(onOpenPanel).toHaveBeenCalledWith('files')
    } finally {
      global.ResizeObserver = Original
    }
  })

  it('immersive layout hugs tabs, exposes drag spacer, and keeps quick launch with collapse', () => {
    const onSelect = vi.fn()
    render(
      <DockTabBar
        variant="immersive"
        active="agent"
        tabs={[
          { id: 'agent', label: 'Agent', icon: 'bot', closable: false },
          defaultDockTab('terminal')
        ]}
        onSelect={onSelect}
        onCloseTab={vi.fn()}
        onOpenPanel={vi.fn()}
        expanded
        onToggleExpanded={vi.fn()}
      />
    )
    const bar = document.querySelector('[data-dock-tab-variant="immersive"]')
    const tablist = bar?.querySelector('[role="tablist"]')
    expect(tablist?.className).toMatch(/\bflex-1\b/)
    const spacer = bar?.querySelector('[data-titlebar-drag-spacer]')
    expect(spacer).toBeTruthy()
    const quickLaunch = document.querySelector('[data-dock-quick-launch]')
    expect(quickLaunch).toBeTruthy()
    const browserLaunch = screen.getByRole('button', { name: /Show browser panel/i })
    const collapse = screen.getByRole('button', { name: /^Collapse panel$/i })
    // Quick launch lives after the drag spacer with collapse — not glued to session +.
    expect(
      spacer!.compareDocumentPosition(quickLaunch!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(browserLaunch.closest('[data-dock-quick-launch]')?.parentElement).toBe(
      collapse.parentElement
    )
  })

  it('keeps empty terminal session + before the drag spacer (not beside quick launch)', () => {
    function Bar() {
      const ref = useRef<HTMLDivElement>(null)
      const [host, setHost] = useState<HTMLDivElement | null>(null)
      useLayoutEffect(() => {
        setHost(ref.current)
      }, [])
      return (
        <>
          <DockTabBar
            variant="immersive"
            active="terminal"
            tabs={[
              { id: 'agent', label: 'Agent', icon: 'bot', closable: false },
              defaultDockTab('terminal')
            ]}
            onSelect={vi.fn()}
            onCloseTab={vi.fn()}
            onOpenPanel={vi.fn()}
            expanded
            onToggleExpanded={vi.fn()}
            terminalSessionBarHostRef={ref}
          />
          {host
            ? createPortal(
                <TerminalSessionBar
                  sessions={[]}
                  activeId={null}
                  splitId={null}
                  onSelect={vi.fn()}
                  onKill={vi.fn()}
                  onCreate={vi.fn()}
                  onToggleSplit={vi.fn()}
                />,
                host
              )
            : null}
        </>
      )
    }
    render(<Bar />)
    const spacer = document.querySelector('[data-titlebar-drag-spacer]')
    const quickLaunch = document.querySelector('[data-dock-quick-launch]')
    const newTerminal = screen.getByRole('button', { name: /^New terminal$/i })
    expect(spacer).toBeTruthy()
    expect(
      newTerminal.compareDocumentPosition(spacer!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(
      spacer!.compareDocumentPosition(quickLaunch!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(document.querySelector('[data-terminal-session-bar]')?.className).toMatch(
      /\binline-flex\b/
    )
    expect(document.querySelector('[data-terminal-session-bar] .flex-1')).toBeNull()
  })

  it('side-dock embedded strip separates New terminal from quick launch', () => {
    function Bar() {
      const ref = useRef<HTMLDivElement>(null)
      const [host, setHost] = useState<HTMLDivElement | null>(null)
      useLayoutEffect(() => {
        setHost(ref.current)
      }, [])
      return (
        <>
          <DockTabBar
            active="terminal"
            tabs={[defaultDockTab('terminal')]}
            onSelect={vi.fn()}
            onCloseTab={vi.fn()}
            onOpenPanel={vi.fn()}
            expanded={false}
            onToggleExpanded={vi.fn()}
            embeddedInTitleBar
            terminalSessionBarHostRef={ref}
          />
          {host
            ? createPortal(
                <TerminalSessionBar
                  sessions={[]}
                  activeId={null}
                  splitId={null}
                  onSelect={vi.fn()}
                  onKill={vi.fn()}
                  onCreate={vi.fn()}
                  onToggleSplit={vi.fn()}
                />,
                host
              )
            : null}
        </>
      )
    }
    render(<Bar />)
    const bar = document.querySelector('[data-dock-embedded="1"]')
    const spacer = bar?.querySelector('[data-titlebar-drag-spacer]')
    expect(spacer).toBeNull()
    const quickLaunch = document.querySelector('[data-dock-quick-launch]')
    const newTerminal = screen.getByRole('button', { name: /^New terminal$/i })
    expect(quickLaunch).toBeTruthy()
    expect(
      newTerminal.compareDocumentPosition(quickLaunch!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(quickLaunch!.parentElement?.className).toMatch(/\bpr-2\b/)
    // Session host is outside the panel tablist.
    const tablist = bar?.querySelector('[role="tablist"]')
    expect(tablist?.contains(document.querySelector('[data-terminal-session-bar-host]')!)).toBe(
      false
    )
  })
})
