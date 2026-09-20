import { useId } from 'react'

import { cn } from '@renderer/lib/ui/cn'
import { VYOTIQ_MARK_PATHS, VYOTIQ_MARK_VIEW_BOX } from '@shared/brand/vyotiqMark'

/**
 * Agent V working indicator — the brand mark, animated.
 *
 * This file owns the markup; styles.css owns the motion. Every variant below
 * is a class the stylesheet selects against (`.vy-agv--<variant>`), so adding
 * one here without a matching rule there renders a still mark, not an error.
 *
 * Deliberately no `data-brand-mark`: a handful of suites assert that attribute
 * is absent from the title bar accessory and the sidebar brand toggle, and a
 * spinner rendering in either region would turn those into false failures.
 */

export type AgentVSpinnerVariant =
  | 'ratchet'
  | 'orbit'
  | 'relay'
  | 'pulse'
  | 'gleam'
  | 'bloom'
  | 'iris'
  | 'vee'

/**
 * The app-wide default. Opacity-only, which is what earns it the slot rather
 * than just making it one of the eight: the geometry never turns, so the mark
 * stays square to the pixel grid and still reads at the 10px call sites, where
 * a rotating variant caught mid-turn is a smudge. That is why there is no
 * size-based fallback here — callers wanting one below ~12px can ask for `vee`.
 *
 * The tray bakes its frames from this same variant — see
 * scripts/generate-spinner-frames.mjs, which hard-codes it because a .mjs build
 * script cannot import from a .tsx. Changing this and not that leaves the tray
 * playing an animation the app no longer shows anywhere.
 */
export const AGENT_V_SPINNER: AgentVSpinnerVariant = 'relay'

// VYOTIQ_MARK_PATHS is generated and positional. Named here once so the rest of
// the file reads as geometry rather than as indexes: the core is the V, and the
// three facets sit at 120° from each other with the left one pointing left —
// which is the order the bloom keyframes translate them in.
const [CORE_PATH, FACET_BR_PATH, FACET_L_PATH, FACET_TR_PATH] = VYOTIQ_MARK_PATHS

// The gleam band spans exactly the travel the keyframes assume: parked at
// x=112 with width=540, `translateX(-540px)` puts its right edge on the mark's
// left edge and `translateX(800px)` puts its left edge on the right edge. Both
// ends of the loop therefore sit flush against the silhouette with no dead beat.
const GLEAM_X = 112
const GLEAM_WIDTH = 540

/** How far the mark is knocked back so the gleam has something to brighten. */
const GLEAM_BASE_OPACITY = 0.45

export function AgentVSpinner({
  size = 16,
  variant,
  idle = false,
  className,
  label
}: {
  size?: number
  /** Overrides the size-derived default. */
  variant?: AgentVSpinnerVariant
  /** Still and dimmed — "not working", without the slot collapsing. */
  idle?: boolean
  className?: string
  /**
   * Only pass this where the spinner is the sole evidence a run is alive.
   * Every current call site sits next to its own visible text inside a
   * `role="status"`, so the default is decorative.
   */
  label?: string
}) {
  const reactId = useId()
  const resolved = variant ?? AGENT_V_SPINNER
  const isGleam = resolved === 'gleam'
  const clipId = `vy-agv-clip-${reactId}`
  const gradientId = `vy-agv-gleam-${reactId}`

  return (
    <svg
      viewBox={VYOTIQ_MARK_VIEW_BOX}
      width={size}
      height={size}
      className={cn('vy-agv', `vy-agv--${resolved}`, idle && 'vy-agv--idle', className)}
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {isGleam ? (
        <defs>
          <clipPath id={clipId}>
            {VYOTIQ_MARK_PATHS.map((d) => (
              <path key={d} d={d} />
            ))}
          </clipPath>
          {/* Same hue as the mark, so the sweep reads as the silhouette coming
              up to full strength rather than as a foreign colour crossing it.
              That is what keeps it honest under an arbitrary currentColor. */}
          <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor="currentColor" stopOpacity="0" />
            <stop offset="0.5" stopColor="currentColor" stopOpacity="1" />
            <stop offset="1" stopColor="currentColor" stopOpacity="0" />
          </linearGradient>
        </defs>
      ) : null}

      <g className="vy-agv-spin" opacity={isGleam && !idle ? GLEAM_BASE_OPACITY : undefined}>
        <g className="vy-agv-ring">
          <path className="vy-agv-f vy-agv-f-tr" fill="currentColor" d={FACET_TR_PATH} />
          <path className="vy-agv-f vy-agv-f-br" fill="currentColor" d={FACET_BR_PATH} />
          <path className="vy-agv-f vy-agv-f-l" fill="currentColor" d={FACET_L_PATH} />
        </g>
        <path className="vy-agv-core" fill="currentColor" d={CORE_PATH} />
      </g>

      {isGleam ? (
        <g clipPath={`url(#${clipId})`}>
          <rect
            className="vy-agv-gleam"
            x={GLEAM_X}
            y={112}
            width={GLEAM_WIDTH}
            height={800}
            fill={`url(#${gradientId})`}
          />
        </g>
      ) : null}
    </svg>
  )
}
