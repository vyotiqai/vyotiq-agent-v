import {
  formatAgentInstanceShortId,
  parseAgentInstanceRunId,
  parseAgentInstanceRunIdFromArgs
} from '@shared/utils/agentInstance'
import { stripGoalMarkdown } from '@renderer/app/sidebar/runTitle'
import { useRunSession } from '../../RunSessionContext'
import type { ToolBodyProps } from '../types'
import { Button } from '@renderer/lib/ui'
import { TOOL_BODY_INNER } from '@renderer/lib/utils/layout'

function resolveInstanceRunId(tool: ToolBodyProps['tool']): string | null {
  return (
    parseAgentInstanceRunId(tool.content) ??
    parseAgentInstanceRunIdFromArgs(tool.argsPreview) ??
    null
  )
}

function displayInstanceContent(content: string | undefined): string {
  return (content ?? '').replace(/^Agent V Instance id;[^\r\n]*(?:\r?\n)?/i, '').trim()
}

export function SpawnAgentInstanceBody({ tool }: ToolBodyProps) {
  const { agentInstances, onOpenAgentInstance } = useRunSession()
  const runId = resolveInstanceRunId(tool)
  const instance = runId ? agentInstances?.[runId] : undefined
  const goal = instance?.goal ? stripGoalMarkdown(instance.goal) : ''
  const shortId = runId ? formatAgentInstanceShortId(runId) : ''

  return (
    <div className={`flex flex-col gap-1.5 ${TOOL_BODY_INNER} text-xs text-fg`}>
      {goal ? (
        <p className="m-0 line-clamp-2 text-muted [overflow-wrap:anywhere]" title={goal}>
          {goal}
        </p>
      ) : null}
      {instance?.pathScope?.length ? (
        <p className="m-0 text-muted">Scope: {instance.pathScope.join(', ')}</p>
      ) : null}
      {instance?.summary && instance.phase !== 'started' ? (
        <p className="m-0 whitespace-pre-wrap">{instance.summary}</p>
      ) : null}
      {runId && onOpenAgentInstance ? (
        <div>
          <Button
            type="button"
            variant="subtle"
            aria-label={`Open instance ${shortId}`}
            onClick={() => onOpenAgentInstance(runId)}
          >
            Open
          </Button>
        </div>
      ) : null}
    </div>
  )
}

export function AwaitAgentInstanceBody({ tool }: ToolBodyProps) {
  const { agentInstances, onOpenAgentInstance } = useRunSession()
  const runId = resolveInstanceRunId(tool)
  const instance = runId ? agentInstances?.[runId] : undefined
  const shortId = runId ? formatAgentInstanceShortId(runId) : ''
  const goal = instance?.goal ? stripGoalMarkdown(instance.goal) : ''
  const content = displayInstanceContent(tool.content)

  return (
    <div className={`flex flex-col gap-1.5 ${TOOL_BODY_INNER} text-xs text-fg`}>
      {goal ? (
        <p className="m-0 line-clamp-2 text-muted [overflow-wrap:anywhere]" title={goal}>
          {goal}
        </p>
      ) : null}
      {instance?.pathScope?.length ? (
        <p className="m-0 text-muted">Scope: {instance.pathScope.join(', ')}</p>
      ) : null}
      {content ? (
        <pre className="m-0 max-h-48 overflow-auto whitespace-pre-wrap">{content}</pre>
      ) : null}
      {runId && onOpenAgentInstance ? (
        <div>
          <Button
            type="button"
            variant="subtle"
            aria-label={`Open instance ${shortId}`}
            onClick={() => onOpenAgentInstance(runId)}
          >
            Open
          </Button>
        </div>
      ) : null}
    </div>
  )
}
