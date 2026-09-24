import { useState } from 'react'
import { workspacePathsEqual } from '@shared/workspacePathMatch'
import { Button, Menu, type MenuOption } from '@renderer/lib/ui'
import { formatWorkspaceName } from '@renderer/lib/utils/formatWorkspaceName'

/**
 * A command field, not a chat box: one line, a workspace, and Enter. Start
 * hands the line to the agent as a new task in that workspace.
 */
export function HomeTaskField({
  workspaces,
  defaultPath,
  onStart
}: {
  workspaces: readonly string[]
  /** The workspace the field targets until another is picked. */
  defaultPath: string | null
  onStart: (workspacePath: string, brief: string) => void
}) {
  const [text, setText] = useState('')
  const [picked, setPicked] = useState<string | null>(null)
  const target =
    (picked && workspaces.find((path) => workspacePathsEqual(path, picked))) ||
    (defaultPath && workspaces.find((path) => workspacePathsEqual(path, defaultPath))) ||
    workspaces[0] ||
    null
  const brief = text.trim()

  const start = (): void => {
    if (!brief || !target) return
    onStart(target, brief)
    setText('')
  }

  const options: MenuOption[] = workspaces.map((path) => ({ value: path, label: formatWorkspaceName(path) }))

  return (
    <div className="mt-4 flex h-12 items-center gap-2 rounded-lg border border-border bg-bg pl-4 pr-2 vy-transition focus-within:border-border-strong hover:border-border-strong">
      <input
        aria-label="New task"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
          e.preventDefault()
          start()
        }}
        className="min-w-0 flex-1 bg-transparent text-md text-fg-strong outline-none placeholder:text-tertiary"
        placeholder="Describe the task — the agent plans it, does it, and shows you the result"
      />
      {target ? (
        workspaces.length > 1 ? (
          <Menu
            value={target}
            options={options}
            onChange={setPicked}
            aria-label="Workspace"
            placement="down"
            triggerClassName="inline-flex h-8 min-w-0 max-w-60 items-center gap-1.5 rounded-md px-2 text-xs text-muted vy-transition hover:bg-surface hover:text-fg focus-visible:vy-focus-ring"
          />
        ) : (
          <span className="max-w-60 truncate px-2 text-xs text-muted" title={target}>
            {formatWorkspaceName(target)}
          </span>
        )
      ) : null}
      <Button variant="primary" size="sm" disabled={!brief || !target} onClick={start}>
        Start
      </Button>
    </div>
  )
}
