import { Fragment, type ReactNode } from 'react'
import type { WorkspaceAgentContextResult } from '@shared/ipc/schemas/agent'
import { useGitInit } from './useGitInit'
import { useAgentContext } from './useAgentContext'

type CodeIndexState = WorkspaceAgentContextResult['codeIndex']['state']

const INDEX_STATE_LABEL: Record<CodeIndexState, string> = {
  ready: 'Ready',
  building: 'Building',
  degraded: 'Degraded',
  off: 'Off',
  paused: 'Paused'
}

const INDEX_STATE_HINT: Record<CodeIndexState, string> = {
  ready: 'Code index is built — the agent can search this workspace by symbol.',
  building: 'Code index is still syncing — recent edits may be missing.',
  degraded: 'Code index is incomplete — the agent falls back to plain file search.',
  off: 'Code index is off for this workspace.',
  paused: 'Indexing is paused — the agent searches what is indexed so far. Resume it in Settings → Indexing.'
}

/** Uneven on purpose, so the pending state reads as text rather than as bars. */
const SKELETON_WIDTHS = ['6.5rem', '5.5rem', '3.75rem', '3rem']

type Reading = {
  key: string
  label: string
  title: string
  value: ReactNode
}

/**
 * Live "what the agent knows" strip for the empty-session state.
 * One bridge fetch on mount, then main pushes a new summary whenever one of
 * the five watched paths actually changes it — no polling, no timers.
 * IPC failure renders nothing (never fake data).
 *
 * Read-only with one exception: when the workspace is not a repository the
 * branch reading offers `git init`, on an explicit click. That click re-reads
 * the summary itself — a watcher does not reliably carry a `.git` that has
 * just been created, which left the strip reading "Not a repo" over a
 * repository that existed.
 *
 * Four label/value readings in one frame. The workspace name is deliberately
 * absent: the empty-state heading directly above already says
 * "New chat in <workspace>", and this strip sits under it.
 */
export function AgentContextCard({ workspacePath }: { workspacePath: string }) {
  const { context, failed, reload } = useAgentContext(workspacePath)

  // Re-read after an init instead of waiting for the watcher to notice `.git`.
  // The watcher is the only refresh on every other path, but it does not carry
  // a directory that has just been created: on Windows the strip still read
  // "Not a repo" fifteen seconds after the repository existed on disk, so the
  // one surface that caused the change refreshes what it changed. The
  // ChangesPanel already did this; only this strip assumed the push. A push
  // that arrives afterwards still applies.
  const gitInit = useGitInit(workspacePath, reload)

  if (failed) return null

  if (!context) {
    return (
      <div className="agent-context-card" data-agent-context-card-skeleton aria-hidden>
        {SKELETON_WIDTHS.map((width, index) => (
          <Fragment key={width}>
            {index > 0 ? <span className="acc-sep" /> : null}
            <span className="acc-item">
              <span className="acc-skel acc-skel-label" />
              <span className="acc-skel acc-skel-value" style={{ width }} />
            </span>
          </Fragment>
        ))}
      </div>
    )
  }

  const { branch, memoryNotes, rules } = context
  const state = context.codeIndex.state

  const ruleNames: string[] = []
  if (rules.agentsMd) ruleNames.push('AGENTS.md')
  if (rules.claudeMd) ruleNames.push('CLAUDE.md')
  if (rules.cursorrules) ruleNames.push('.cursorrules')
  if (rules.ruleFileCount > 0) ruleNames.push(`${rules.ruleFileCount} rules`)

  const readings: Reading[] = [
    {
      key: 'branch',
      label: 'Branch',
      title: branch
        ? `Git branch: ${branch}`
        : `${context.workspaceName} is not a git repository`,
      value: branch ? (
        <span>{branch}</span>
      ) : (
        <>
          <span
            className={gitInit.error ? 'acc-value-error' : 'acc-value-empty'}
            title={gitInit.error ?? undefined}
          >
            {gitInit.error ? 'Init failed' : 'Not a repo'}
          </span>
          <button
            type="button"
            className="acc-action"
            disabled={gitInit.busy}
            aria-busy={gitInit.busy || undefined}
            title={`Run git init in ${context.workspaceName}`}
            onClick={() => {
              void gitInit.init()
            }}
          >
            Initialize
          </button>
        </>
      )
    },
    {
      key: 'rules',
      label: 'Rules',
      title:
        ruleNames.length > 0
          ? `Project rules the agent reads: ${ruleNames.join(', ')}`
          : 'No project rules found in this workspace',
      value:
        ruleNames.length > 0 ? (
          ruleNames.map((name, index) => (
            <Fragment key={name}>
              {index > 0 ? (
                <span className="acc-dim" aria-hidden>
                  ·
                </span>
              ) : null}
              <span>{name}</span>
            </Fragment>
          ))
        ) : (
          <span className="acc-value-empty">None</span>
        )
    },
    {
      key: 'memory',
      label: 'Memory',
      title:
        memoryNotes > 0
          ? `${memoryNotes} memory note${memoryNotes === 1 ? '' : 's'} stored for this workspace`
          : 'No memory notes stored for this workspace yet',
      value:
        memoryNotes > 0 ? (
          <span>
            {memoryNotes} note{memoryNotes === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="acc-value-empty">None</span>
        )
    },
    {
      key: 'index',
      label: 'Index',
      title: INDEX_STATE_HINT[state],
      value: (
        <>
          <span className={`acc-dot acc-dot-${state}`} aria-hidden />
          <span>{INDEX_STATE_LABEL[state]}</span>
        </>
      )
    }
  ]

  return (
    <div
      role="group"
      aria-label="What the agent knows"
      data-agent-context-card
      className="agent-context-card"
    >
      {readings.map((reading, index) => (
        <Fragment key={reading.key}>
          {index > 0 ? <span className="acc-sep" aria-hidden /> : null}
          <div className="acc-item" data-acc-item={reading.key} title={reading.title}>
            <span className="acc-label">{reading.label}</span>
            <span className="acc-value">{reading.value}</span>
          </div>
        </Fragment>
      ))}
    </div>
  )
}
