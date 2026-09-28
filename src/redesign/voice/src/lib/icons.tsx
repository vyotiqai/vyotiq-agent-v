import { CloudIcon, MicrophoneSlashIcon } from '@phosphor-icons/react'
import { Icon, isIconName, type IconName, type IconProps } from '@renderer/lib/icons'

/**
 * The real allowlist, plus the icons this redesign proposes adding to it.
 *
 * CLAUDE.md: icons come from `lib/icons`, never straight from Phosphor. The
 * mockups may not edit the shipped allowlist, so the proposals live here —
 * each one is listed in README.md under "Icons to add", and porting means
 * moving these lines into `src/renderer/src/lib/icons/index.tsx`.
 */
const PROPOSED = {
  micSlash: MicrophoneSlashIcon,
  cloud: CloudIcon
} as const

export type VoiceIconName = IconName | keyof typeof PROPOSED

export function VIcon({ name, size = 16, weight = 'regular', className, ...props }: IconProps & { name: VoiceIconName }) {
  if (isIconName(name)) return <Icon name={name} size={size} weight={weight} className={className} {...props} />
  const Cmp = PROPOSED[name]
  return (
    <Cmp
      size={size}
      weight={weight}
      aria-hidden="true"
      focusable="false"
      className={['inline-block shrink-0 align-middle', className].filter(Boolean).join(' ')}
      {...props}
    />
  )
}
