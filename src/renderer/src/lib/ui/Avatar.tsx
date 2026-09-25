import { Icon, isIconName, type IconName } from '../icons'
import { cn } from './cn'

/**
 * Identity chip for a named thing — an agent, an author.
 *
 * Renders the named icon when the key resolves, otherwise the first character
 * of the name. The fallback is not defensive padding: `avatar` is free
 * `z.string().max(32)` text, so an unknown key is a normal state, not a bug.
 *
 * Colour stays on the accent token deliberately. The app is themed across five
 * skins and two themes from `--vy-*` tokens alone, so a per-name hue would be
 * the one element that cannot follow the theme — identity comes from the icon.
 */

const avatarSizes = {
  xs: 'size-5 text-2xs',
  sm: 'size-6 text-2xs',
  md: 'size-8 text-xs',
  lg: 'size-10 text-sm'
} as const

const avatarIconSizes: Record<keyof typeof avatarSizes, number> = {
  xs: 12,
  sm: 14,
  md: 18,
  lg: 22
}

const avatarTones = {
  accent: 'bg-accent/15 text-accent',
  muted: 'bg-surface-2 text-muted'
} as const

export function Avatar({
  name,
  icon,
  size = 'sm',
  tone = 'accent',
  className
}: {
  /** Used for the initial when `icon` does not resolve. */
  name: string
  /** Icon key as stored; anything unrecognized falls back to the initial. */
  icon?: string | null
  size?: keyof typeof avatarSizes
  tone?: keyof typeof avatarTones
  className?: string
}) {
  const resolved: IconName | null = isIconName(icon) ? icon : null
  return (
    <span
      className={cn(
        'grid shrink-0 place-items-center rounded font-semibold',
        avatarSizes[size],
        avatarTones[tone],
        className
      )}
      data-avatar
      aria-hidden
    >
      {resolved ? (
        <Icon name={resolved} size={avatarIconSizes[size]} />
      ) : (
        (name.trim().slice(0, 1) || '?').toUpperCase()
      )}
    </span>
  )
}
