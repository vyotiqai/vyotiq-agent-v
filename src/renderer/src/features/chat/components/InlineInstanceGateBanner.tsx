import type { InlineInstanceGate } from '../hooks/useInlineInstanceUi'
import { formatAgentInstanceLabel } from '@shared/utils/agentInstance'
import { Alert, Button } from '@renderer/lib/ui'

type InlineInstanceGateBannerProps = {
  gates: InlineInstanceGate[]
  onOpenInstance: (runId: string) => void
  className?: string
}

export function InlineInstanceGateBanner({
  gates,
  onOpenInstance,
  className = 'w-full'
}: InlineInstanceGateBannerProps) {
  if (gates.length === 0) return null

  return (
    <Alert variant="info" className={className}>
      <div className="flex flex-col gap-2">
        {gates.map((gate) => (
          <div key={gate.runId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {formatAgentInstanceLabel(gate.runId)} needs{' '}
              {gate.kind === 'approval' ? 'tool approval' : 'an answer'}.
            </span>
            <Button type="button" variant="subtle" onClick={() => onOpenInstance(gate.runId)}>
              Open instance
            </Button>
          </div>
        ))}
      </div>
    </Alert>
  )
}
