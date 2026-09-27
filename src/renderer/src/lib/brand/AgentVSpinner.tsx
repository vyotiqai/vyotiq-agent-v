import { cn } from '@renderer/lib/ui/cn'
import { VYOTIQ_MARK_PATHS, VYOTIQ_MARK_VIEW_BOX } from '@shared/brand/vyotiqMark'

/**
 * Agent V working indicator — the brand mark, animated.
 *
 * This file owns the markup; styles.css owns the motion, selecting against
 * `.vy-agv--<variant>`. Renaming the variant here without its rule there
 * renders a still mark, not an error.
 *
 * Always decorative: every call site sits next to its own visible text inside
 * a `role="status"`.
 *
 * Deliberately no `data-brand-mark`: a handful of suites assert that attribute
 * is absent from the title bar accessory and the sidebar brand toggle, and a
 * spinner rendering in either region would turn those into false failures.
 */

export type AgentVSpinnerVariant = 'relay'

/**
 * The one animation: each facet takes the light in turn. Opacity only, so the
 * geometry never turns, the mark stays square to the pixel grid, and it still
 * reads at the 10px call sites, where a rotating mark caught mid-turn is a
 * smudge.
 *
 * The tray bakes its frames from this same variant — see
 * scripts/generate-spinner-frames.mjs, which hard-codes it because a .mjs build
 * script cannot import from a .tsx. Changing this and not that leaves the tray
 * playing an animation the app no longer shows anywhere.
 */
export const AGENT_V_SPINNER: AgentVSpinnerVariant = 'relay'

// VYOTIQ_MARK_PATHS is generated and positional. Named here once so the rest of
// the file reads as geometry rather than as indexes: the core is the V, and the
// three facets sit at 120° from each other, lit clockwise from the top right.
const [CORE_PATH, FACET_BR_PATH, FACET_L_PATH, FACET_TR_PATH] = VYOTIQ_MARK_PATHS

export function AgentVSpinner({ size = 16, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox={VYOTIQ_MARK_VIEW_BOX}
      width={size}
      height={size}
      className={cn('vy-agv', `vy-agv--${AGENT_V_SPINNER}`, className)}
      aria-hidden
      focusable="false"
    >
      <path className="vy-agv-f vy-agv-f-tr" fill="currentColor" d={FACET_TR_PATH} />
      <path className="vy-agv-f vy-agv-f-br" fill="currentColor" d={FACET_BR_PATH} />
      <path className="vy-agv-f vy-agv-f-l" fill="currentColor" d={FACET_L_PATH} />
      <path fill="currentColor" d={CORE_PATH} />
    </svg>
  )
}
