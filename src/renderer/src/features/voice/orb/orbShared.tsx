import type { VoiceSessionState } from '@shared/voiceSession'

/*
  What the two orb engines share: colour resolution from the skin's tokens,
  the reduced-motion check, and the mark muted and stopped carry so they are
  never told apart by stillness and colour alone.
*/

export type Rgb = [number, number, number]

/** Any CSS colour (hex, rgb, oklch, color-mix…) as 0..1 RGB, via the browser's own parser. */
export function resolveColor(css: string, scratch: CanvasRenderingContext2D): Rgb {
  scratch.clearRect(0, 0, 1, 1)
  scratch.fillStyle = '#000'
  scratch.fillStyle = css
  scratch.fillRect(0, 0, 1, 1)
  const d = scratch.getImageData(0, 0, 1, 1).data
  return [d[0]! / 255, d[1]! / 255, d[2]! / 255]
}

/** Resolve a set of `--vy-*` tokens on an element (a shader can't take var()). */
export function readTokens<K extends string>(el: Element, vars: Record<K, string>): Record<K, Rgb> {
  const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  const style = getComputedStyle(el)
  const out = {} as Record<K, Rgb>
  for (const key of Object.keys(vars) as K[]) out[key] = resolveColor(style.getPropertyValue(vars[key]).trim() || 'gray', scratch)
  return out
}

export function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true
}

export function StateMark({ state, size }: { state: VoiceSessionState; size: number }) {
  if (state !== 'paused' && state !== 'error') return null
  const stroke = Math.max(3, 300 / size)
  return (
    <svg className="absolute text-fg-strong" width={size} height={size} viewBox="0 0 100 100" aria-hidden="true">
      {state === 'paused' ? (
        <line x1="38" y1="62" x2="62" y2="38" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
      ) : (
        <>
          <line x1="50" y1="38" x2="50" y2="54" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" />
          <circle cx="50" cy="63" r={Math.max(1.8, 180 / size)} fill="currentColor" />
        </>
      )}
    </svg>
  )
}
