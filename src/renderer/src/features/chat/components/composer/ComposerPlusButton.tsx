import { Icon } from '@renderer/lib/icons'
import { Tooltip } from '@renderer/lib/ui/Tooltip'
import { chromeIconButton } from './composerChrome'

const PLUS_LABEL = 'Attach files'
const PLUS_FULL_LABEL = 'Attachment limits reached'

export function ComposerPlusButton({
  disabled,
  attachFull,
  attachHint,
  onAttach
}: {
  disabled?: boolean
  attachFull?: boolean
  /** Per-bucket capacity summary while only some buckets are full. */
  attachHint?: string | null
  onAttach: () => void
}) {
  const blocked = Boolean(disabled) || Boolean(attachFull)
  const label = attachFull
    ? PLUS_FULL_LABEL
    : attachHint
      ? `Attach files — ${attachHint}`
      : PLUS_LABEL
  return (
    <Tooltip content={label}>
      <button
        type="button"
        className={chromeIconButton}
        aria-label={label}
        disabled={blocked}
        data-composer-plus
        onMouseDown={(e) => e.preventDefault()}
        onClick={onAttach}
      >
        <Icon name="plus" size={16} />
      </button>
    </Tooltip>
  )
}
