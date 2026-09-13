import { Button } from '@renderer/lib/ui'
import { Icon } from '@renderer/lib/icons'

export function WorkspaceEnableControls({
  label = 'This workspace:',
  formLocked,
  ws,
  onForceOn,
  onForceOff,
  onUseGlobal,
  className
}: {
  label?: string
  formLocked: boolean
  ws: boolean | undefined
  onForceOn: () => void
  onForceOff: () => void
  onUseGlobal: () => void
  className?: string
}) {
  return (
    <div className={className ?? 'mt-2 flex flex-wrap items-center gap-2'}>
      <span className="text-muted text-caption">{label}</span>
      <Button
        variant="subtle"
        disabled={formLocked}
        aria-pressed={ws === true}
        onClick={onForceOn}
      >
        Force on
        {ws === true ? <Icon name="check" size={12} className="ml-1" /> : null}
      </Button>
      <Button
        variant="subtle"
        disabled={formLocked}
        aria-pressed={ws === false}
        onClick={onForceOff}
      >
        Force off
        {ws === false ? <Icon name="check" size={12} className="ml-1" /> : null}
      </Button>
      <Button
        variant="subtle"
        disabled={formLocked || ws === undefined}
        onClick={onUseGlobal}
      >
        Use global
      </Button>
    </div>
  )
}
