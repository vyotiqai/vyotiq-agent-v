import { useEffect, useRef, useState } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { VoiceOrb } from '../VoiceOrb'
import { SHADER_LOOKS, type ShaderLookId } from './orbLooks'
import { readTokens, reducedMotion, StateMark, type Rgb } from './orbShared'

/*
  The design canvas's orbs (orbLooks.ts) driven by the voice session. Every
  look takes the same four motions, eased so a state change never jumps:
  the voice level (your voice while hearing, its voice while speaking), a
  breath while listening, thinking (faster turning; part of it while the task
  works), and speaking (each look's own speech motion). Needs you swells;
  muted and off slow down and go grey and carry a mark (StateMark).

  Colour comes from the skin: the look's base token (the accent, or the text
  colour for the monochrome looks), or the state's own tone (warning,
  danger, muted). On a light ground a tint is darkened along its hue until it
  holds 3:1 against the page, and the shaders switch their glows from light
  to coverage (uLight). Tokens are re-read when the skin or theme changes.

  Cost: one canvas at ≤2× DPR, paused offscreen and in a hidden window, one
  still frame per state under reduced motion. A lost context is rebuilt; no
  WebGL falls back to the drawn orb (VoiceOrb).
*/

type Tone = 'base' | 'muted' | 'warning' | 'danger' | 'tertiary'

type Motion = {
  /** Faster turning and churn. */
  th: number
  /** The look's speech motion. */
  sp: number
  /** A slow swell (needs you, connecting). */
  pulse: number
  /** A small resting breath (listening). */
  breath: number
  /** How much the voice level moves it. */
  react: number
  /** Overall pace of time. */
  pace: number
  /** Towards grey. */
  dim: number
  tone: Tone
}

const M = (m: Partial<Motion>): Motion => ({ th: 0, sp: 0, pulse: 0, breath: 0, react: 0, pace: 1, dim: 0, tone: 'base', ...m })

const MOTION: Record<VoiceSessionState, Motion> = {
  off: M({ pace: 0.15, dim: 0.7, tone: 'tertiary' }),
  connecting: M({ th: 0.3, pulse: 0.5, pace: 0.6, dim: 0.4, tone: 'muted' }),
  listening: M({ breath: 1 }),
  hearing: M({ react: 1 }),
  thinking: M({ th: 1 }),
  working: M({ th: 0.55, breath: 0.6 }),
  speaking: M({ sp: 1, react: 0.9 }),
  waiting_on_you: M({ pulse: 1 }),
  paused: M({ pace: 0.2, dim: 0.85, tone: 'muted' }),
  reconnecting: M({ th: 0.5, pulse: 0.4, tone: 'warning' }),
  error: M({ pace: 0.2, dim: 0.1, tone: 'danger' })
}

const NUMERIC = ['th', 'sp', 'pulse', 'breath', 'react', 'pace', 'dim'] as const

const TOKENS = {
  accent: '--vy-accent',
  fg: '--vy-fg-strong',
  muted: '--vy-muted',
  warning: '--vy-warning',
  danger: '--vy-danger',
  tertiary: '--vy-tertiary',
  bg: '--vy-bg'
} as const

const QUAD_VS = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'

const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4))
const enc = (v: number): number => (v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055)
const luminance = (c: Rgb): number => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2])

/** Keep a tint at 3:1 or better on its ground, along its own hue. */
function fit(c: Rgb, light: boolean): Rgb {
  const y = luminance(c)
  if (light) return y > 0.2 ? (c.map((v) => enc((lin(v) * 0.2) / y)) as Rgb) : c
  return y < 0.12 ? (c.map((v) => v + (1 - v) * 0.6) as Rgb) : c
}

function toward(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]
}

/** Points spread evenly over the sphere (golden-angle spiral), each a little in or out of the shell. */
function cloudPoints(n: number): Float32Array {
  const data = new Float32Array(n * 4)
  for (let i = 0; i < n; i++) {
    const y = 1 - ((i + 0.5) / n) * 2
    const rad = Math.sqrt(1 - y * y)
    const a = i * 2.399963
    const shell = 1 + (Math.random() - 0.5) * 0.06
    data.set([Math.cos(a) * rad * shell, y * shell, Math.sin(a) * rad * shell, Math.random()], i * 4)
  }
  return data
}

export function ShaderOrb({ look, state, size, level }: { look: ShaderLookId; state: VoiceSessionState; size: number; level?: () => number }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [failed, setFailed] = useState(false)
  // A restored context re-runs the effect.
  const [generation, setGeneration] = useState(0)
  // Read inside the loop, so a state change never restarts it (the motion eases across).
  const target = useRef({ state, level })
  target.current = { state, level }
  const redraw = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const spec = SHADER_LOOKS[look]
    // A canvas per run: a context given back on cleanup can't be had again from the same element (StrictMode remounts).
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    canvas.style.gridArea = '1 / 1'
    host.prepend(canvas)
    const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true })
    const fail = (why: string, detail?: string | null): void => {
      console.warn(`[orb] ${why}; using the drawn orb`, detail ?? '')
      canvas.remove()
      setFailed(true)
    }
    if (!gl) return fail('no WebGL')
    if (spec.derivatives && !gl.getExtension('OES_standard_derivatives')) return fail('no OES_standard_derivatives')
    const compile = (type: number, src: string): WebGLShader | null => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
      fail(`${look} shader did not compile`, gl.getShaderInfoLog(s))
      return null
    }
    const vs = compile(gl.VERTEX_SHADER, spec.vs ?? QUAD_VS)
    const fs = vs && compile(gl.FRAGMENT_SHADER, spec.fs)
    if (!vs || !fs) return
    const prog = gl.createProgram()!
    gl.attachShader(prog, vs)
    gl.attachShader(prog, fs)
    gl.linkProgram(prog)
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return fail(`${look} program did not link`, gl.getProgramInfoLog(prog))
    gl.useProgram(prog)

    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)

    // Fewer points on a small orb, or they crowd into a scribble.
    const points = spec.points ? Math.round(spec.points * Math.min(1, Math.max(0.3, size / 320))) : 0
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
    if (points) {
      gl.bufferData(gl.ARRAY_BUFFER, cloudPoints(points), gl.STATIC_DRAW)
      const aP = gl.getAttribLocation(prog, 'aP')
      const aR = gl.getAttribLocation(prog, 'aR')
      gl.enableVertexAttribArray(aP)
      gl.vertexAttribPointer(aP, 3, gl.FLOAT, false, 16, 0)
      gl.enableVertexAttribArray(aR)
      gl.vertexAttribPointer(aR, 1, gl.FLOAT, false, 16, 12)
      gl.enable(gl.BLEND)
    } else {
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
      const loc = gl.getAttribLocation(prog, 'p')
      gl.enableVertexAttribArray(loc)
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
    }
    const u: Record<string, WebGLUniformLocation | null> = {}
    for (const name of ['uRes', 'uDpr', 'uBands', 'uT', 'uLv', 'uTh', 'uSp', 'uTint', 'uLight', 'uCell', 'uSize']) u[name] = gl.getUniformLocation(prog, name)
    // The canvas drew at 400 CSS px: dots and points keep their look as the orb shrinks, down to a floor that still reads.
    const scale = size / 400
    gl.uniform2f(u.uRes!, canvas.width, canvas.height)
    gl.uniform1f(u.uDpr!, dpr)
    gl.uniform1f(u.uCell!, Math.max(3, 9 * scale) * dpr)
    gl.uniform1f(u.uSize!, Math.max(0.7, 1.5 * Math.sqrt(scale)) * dpr)
    gl.uniform1f(u.uBands!, Math.max(4, 9 * Math.min(1, size / 300)))

    const still = reducedMotion()
    let tokens = readTokens(canvas, TOKENS)
    const skinHost = canvas.closest('[data-skin]') ?? document.documentElement
    const mo = new MutationObserver(() => {
      tokens = readTokens(canvas, TOKENS)
      if (still) draw(1)
    })
    mo.observe(skinHost, { attributes: true, attributeFilter: ['data-skin', 'data-theme', 'class'] })
    if (skinHost !== document.documentElement) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })

    const toneOf = (m: Motion): Rgb => (m.tone === 'base' ? tokens[spec.base] : tokens[m.tone])
    const cur = { ...MOTION[target.current.state] }
    let color = toneOf(cur)
    let lv = 0
    let t = 0
    let clock = 0
    let last = performance.now()
    let raf = 0
    let visible = true

    const draw = (dt: number): void => {
      const goal = MOTION[target.current.state]
      const k = still ? 1 : Math.min(1, dt * 4)
      for (const key of NUMERIC) cur[key] += (goal[key] - cur[key]) * k
      color = toward(color, toneOf(goal), k)
      clock += dt
      const voice = goal.react > 0 && target.current.level && !still ? Math.min(1, Math.max(0, target.current.level())) : still && goal.react > 0 ? 0.55 : 0
      const want = voice * cur.react + cur.breath * (0.05 + 0.04 * Math.sin(clock * 1.6)) + cur.pulse * 0.22 * (0.5 + 0.5 * Math.sin(clock * 3.2))
      lv += (want - lv) * (still ? 1 : Math.min(1, dt * 12))
      t += dt * cur.pace * (0.6 + cur.th * 1.2 + lv * 0.8)
      const light = luminance(tokens.bg) > 0.5
      const grey = luminance(color)
      const tint = fit(toward(color, [grey, grey, grey].map(enc) as Rgb, cur.dim), light)
      gl.uniform1f(u.uT!, still ? 6 : t)
      gl.uniform1f(u.uLv!, lv)
      gl.uniform1f(u.uTh!, cur.th)
      gl.uniform1f(u.uSp!, cur.sp)
      gl.uniform1f(u.uLight!, light ? 1 : 0)
      gl.uniform3f(u.uTint!, tint[0], tint[1], tint[2])
      // A point cloud adds light on a dark ground; on a light one dense points must deepen, not grey out.
      if (points) gl.blendFunc(gl.ONE, light ? gl.ONE_MINUS_SRC_ALPHA : gl.ONE)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(points ? gl.POINTS : gl.TRIANGLE_STRIP, 0, points || 4)
    }

    let drawn = false
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      // The first frame is always drawn, so an orb that starts offscreen is never empty when it scrolls in.
      if ((visible || !drawn) && !document.hidden) {
        draw(dt)
        drawn = true
      }
      raf = requestAnimationFrame(tick)
    }

    const onLost = (e: Event): void => {
      e.preventDefault()
      cancelAnimationFrame(raf)
    }
    const onRestored = (): void => setGeneration((g) => g + 1)
    canvas.addEventListener('webglcontextlost', onLost)
    canvas.addEventListener('webglcontextrestored', onRestored)
    const io = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true))
    io.observe(canvas)

    if (still) {
      // One frame per state: the effect below redraws on a state change, the observer on a skin change.
      redraw.current = () => draw(1)
      draw(1)
    } else {
      raf = requestAnimationFrame(tick)
    }
    return () => {
      redraw.current = null
      cancelAnimationFrame(raf)
      io.disconnect()
      mo.disconnect()
      canvas.removeEventListener('webglcontextlost', onLost)
      canvas.removeEventListener('webglcontextrestored', onRestored)
      // Contexts are few (~16 per page): give this one back.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [look, size, generation])

  // Reduced motion: a new still frame when the state changes.
  useEffect(() => redraw.current?.(), [state])

  if (failed) return <VoiceOrb state={state} size={size} level={level} />

  return (
    <span ref={hostRef} className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-live-orb={state} data-orb-look={look}>
      <StateMark state={state} size={size} />
    </span>
  )
}
