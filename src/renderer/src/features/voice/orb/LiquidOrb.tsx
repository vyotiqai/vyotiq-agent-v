import { useEffect, useRef, useState } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { VoiceOrb } from '../VoiceOrb'
import { reducedMotion, resolveColor, StateMark, type Rgb } from './orbShared'

/*
  The orb as motion graphics: a WebGL sphere of slowly flowing colour, lit
  from the top left, whose edge ripples with the voice level and whose glow
  breathes. Each state is its own motion, not only its own colour (WCAG
  1.4.1): a calm drift while listening, a ripple that follows your voice, a
  swirl while thinking, a band of light circling while the task works, a
  pulse when it needs you, and stillness when muted. Changes of state ease
  over ~300 ms, so it never jumps.

  Colour comes from the skin: the tone token (accent, muted, warning,
  danger) is read from the element's computed style and resolved to RGB,
  because a shader can't take var(). The one derived step is mixing that
  tone towards black for depth and towards white for light, so it holds in
  all five skins, light and dark. It re-reads when the skin or theme changes.

  Cost: one small canvas, rendered at ≤2× DPR, paused when offscreen or the
  window is hidden; one still frame per state under reduced motion. Without
  WebGL it falls back to the drawn orb (VoiceOrb).
*/

type Tone = 'accent' | 'muted' | 'warning' | 'danger' | 'tertiary'

type Params = {
  tone: Tone
  /** How fast the colour inside flows. */
  flow: number
  /** How much the edge wobbles on its own. */
  turb: number
  /** How fast the inside turns. */
  swirl: number
  /** Glow outside the edge. */
  glow: number
  /** Towards grey. */
  dim: number
  /** A band of light circling the rim (work happening elsewhere). */
  band: number
  /** A slow swell of the whole sphere. */
  pulse: number
  /** How much the voice level moves it. */
  react: number
}

const PARAMS: Record<VoiceSessionState, Params> = {
  off: { tone: 'tertiary', flow: 0, turb: 0, swirl: 0, glow: 0, dim: 0.6, band: 0, pulse: 0, react: 0 },
  connecting: { tone: 'muted', flow: 0.35, turb: 0.05, swirl: 0, glow: 0.12, dim: 0.35, band: 0, pulse: 1, react: 0 },
  listening: { tone: 'accent', flow: 0.45, turb: 0.15, swirl: 0.12, glow: 0.28, dim: 0.12, band: 0, pulse: 0.6, react: 0 },
  hearing: { tone: 'accent', flow: 1, turb: 0.35, swirl: 0.2, glow: 0.45, dim: 0, band: 0, pulse: 0, react: 1 },
  thinking: { tone: 'accent', flow: 1.9, turb: 0.22, swirl: 1.5, glow: 0.38, dim: 0, band: 0, pulse: 0.35, react: 0 },
  working: { tone: 'accent', flow: 0.7, turb: 0.08, swirl: 0.45, glow: 0.26, dim: 0.08, band: 1, pulse: 0, react: 0 },
  speaking: { tone: 'accent', flow: 1.3, turb: 0.45, swirl: 0.3, glow: 0.55, dim: 0, band: 0, pulse: 0, react: 1 },
  waiting_on_you: { tone: 'accent', flow: 0.55, turb: 0.1, swirl: 0.1, glow: 0.65, dim: 0, band: 0, pulse: 1.7, react: 0 },
  paused: { tone: 'muted', flow: 0.12, turb: 0, swirl: 0, glow: 0, dim: 0.85, band: 0, pulse: 0, react: 0 },
  reconnecting: { tone: 'warning', flow: 0.4, turb: 0.18, swirl: 0.3, glow: 0.2, dim: 0.15, band: 0.8, pulse: 0.5, react: 0 },
  error: { tone: 'danger', flow: 0.15, turb: 0.04, swirl: 0, glow: 0.22, dim: 0.05, band: 0, pulse: 0, react: 0 }
}

const TONE_VAR: Record<Tone, string> = {
  accent: '--vy-accent',
  muted: '--vy-muted',
  warning: '--vy-warning',
  danger: '--vy-danger',
  tertiary: '--vy-tertiary'
}

const VERT = `attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}`

// Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
const FRAG = `precision highp float;
uniform vec2 uRes;uniform float uTime,uLevel,uFlow,uTurb,uSwirl,uGlow,uDim,uBand,uPulse;
uniform vec3 uDeep,uMid,uLight,uAlt;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 perm(vec4 x){return m289(((x*34.)+1.)*x);}
vec4 tis(vec4 r){return 1.79284291400159-.85373472095314*r;}
float snoise(vec3 v){
  const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);
  vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);
  vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);
  vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;
  i=m289(i);
  vec4 p=perm(perm(perm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));
  float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;
  vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);
  vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);
  vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);
  vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));
  vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;
  vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);
  vec4 norm=tis(vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3)));
  p0*=norm.x;p1*=norm.y;p2*=norm.z;p3*=norm.w;
  vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;
  return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));
}
void main(){
  float half_=.5*min(uRes.x,uRes.y);
  vec2 uv=(gl_FragCoord.xy-.5*uRes)/half_;
  float r=length(uv);float a=atan(uv.y,uv.x);float t=uTime;
  float base=.62+uPulse*.03*sin(t*2.1)+uLevel*.08;
  float e1=snoise(vec3(cos(a)*1.3,sin(a)*1.3,t*.35*(uFlow+.2)+3.));
  float e2=snoise(vec3(cos(a)*3.1,sin(a)*3.1,t*1.1*(uFlow+.2)+7.));
  float radius=base+e1*(.004+uTurb*.022+uLevel*.05)+e2*(uTurb*.006+uLevel*.035);
  float aa=1.5/half_;
  float inside=1.-smoothstep(radius-aa,radius+aa,r);
  // Liquid inside: a soft vertical gradient, gently warped, with three blobs of colour drifting through it.
  float ang=uSwirl*t*.6;mat2 rot=mat2(cos(ang),-sin(ang),sin(ang),cos(ang));
  float ft=t*.32*(uFlow+.08);
  vec2 w=uv+.16*vec2(snoise(vec3(uv*1.1,ft)),snoise(vec3(uv*1.1+7.3,ft+1.7)));
  w=rot*w;
  vec3 col=mix(uDeep,uMid,smoothstep(-.85,.75,w.y+.3*snoise(vec3(w*.8,ft*.7+2.))));
  vec2 c1=.3*vec2(sin(ft*1.3),cos(ft*1.1));
  vec2 c2=.32*vec2(cos(ft*.9+2.),sin(ft*1.4+1.));
  vec2 c3=.26*vec2(sin(ft*1.7+4.),cos(ft*.8+3.));
  col=mix(col,uAlt,.7*exp(-dot(w-c1,w-c1)*4.5));
  col=mix(col,uLight,(.65+uLevel*.3)*exp(-dot(w-c2,w-c2)*(6.-uLevel*2.5)));
  col=mix(col,uMid,.55*exp(-dot(w-c3,w-c3)*7.));
  float z=sqrt(max(0.,1.-pow(min(r/radius,1.),2.)));
  // Glass: a little darker towards the edge, a soft highlight, a lit rim.
  col*=.84+.22*z;
  float spec=exp(-pow(length((uv-vec2(-.22,.26)*radius/.62)*vec2(1.,1.35)),2.)*14.);
  col=mix(col,uLight,spec*.3);
  float rim=smoothstep(radius-.09,radius,r)*inside;
  col=mix(col,uLight,rim*.35);
  col=mix(col,uLight,uLevel*.18*z);
  float da=atan(sin(a-t*1.7),cos(a-t*1.7));
  float band=exp(-da*da*4.)*smoothstep(radius-.2,radius,r);
  col=mix(col,uLight,clamp(uBand*band*.85,0.,1.));
  col=mix(col,vec3(dot(col,vec3(.299,.587,.114))),uDim);
  float d=max(0.,r-radius);
  // Fades to nothing before the canvas edge, so it never shows a square.
  float glow=exp(-d*7.)*uGlow*(.55+uLevel*.9)*(1.-inside)*smoothstep(.98,.7,r);
  gl_FragColor=vec4(col*inside+uMid*glow,clamp(inside+glow,0.,1.));
}`

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

function toHsl([r, g, b]: Rgb): Rgb {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return [0, 0, l]
  const d = max - min
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
  return [h / 6, s, l]
}

function fromHsl([h, s, l]: Rgb): Rgb {
  if (s === 0) return [l, l, l]
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s
  const p = 2 * l - q
  const ch = (t: number): number => {
    const x = ((t % 1) + 1) % 1
    if (x < 1 / 6) return p + (q - p) * 6 * x
    if (x < 1 / 2) return q
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6
    return p
  }
  return [ch(h + 1 / 3), ch(h), ch(h - 1 / 3)]
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v))

/**
 * The tone's neighbours on the colour wheel, so one token makes a living
 * gradient: deeper and a step round one way, lighter and a step the other,
 * and a third hue for the drifting blob. A grey tone stays grey.
 */
function palette(tone: Rgb): { deep: Rgb; light: Rgb; alt: Rgb } {
  const [h, s, l] = toHsl(tone)
  return {
    deep: fromHsl([h - 0.07, clamp01(s * 1.05), clamp01(l * 0.58)]),
    light: fromHsl([h + 0.05, clamp01(s * 0.85), clamp01(l + (0.95 - l) * 0.6)]),
    alt: fromHsl([h + 0.11, clamp01(s), clamp01(l * 0.95 + 0.04)])
  }
}

function readTones(el: Element): Record<Tone, Rgb> {
  const scratch = document.createElement('canvas').getContext('2d', { willReadFrequently: true })!
  const style = getComputedStyle(el)
  const out = {} as Record<Tone, Rgb>
  for (const tone of Object.keys(TONE_VAR) as Tone[]) out[tone] = resolveColor(style.getPropertyValue(TONE_VAR[tone]).trim() || 'gray', scratch)
  return out
}

type Gl = {
  gl: WebGLRenderingContext
  u: Record<string, WebGLUniformLocation | null>
}

function setup(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false })
  if (!gl) return null
  const shader = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)!
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
    console.warn('[orb] shader did not compile; using the drawn orb', gl.getShaderInfoLog(s))
    return null
  }
  const vs = shader(gl.VERTEX_SHADER, VERT)
  const fs = shader(gl.FRAGMENT_SHADER, FRAG)
  if (!vs || !fs) return null
  const prog = gl.createProgram()!
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  const buf = gl.createBuffer()
  gl.bindBuffer(gl.ARRAY_BUFFER, buf)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u: Gl['u'] = {}
  for (const name of ['uRes', 'uTime', 'uLevel', 'uFlow', 'uTurb', 'uSwirl', 'uGlow', 'uDim', 'uBand', 'uPulse', 'uDeep', 'uMid', 'uLight', 'uAlt']) {
    u[name] = gl.getUniformLocation(prog, name)
  }
  return { gl, u }
}

const NUMERIC = ['flow', 'turb', 'swirl', 'glow', 'dim', 'band', 'pulse', 'react'] as const

type OrbProps = { state: VoiceSessionState; size: number; level?: () => number }

export function LiquidOrb({ state, size, level }: OrbProps) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [failed, setFailed] = useState(false)
  // Read inside the loop, so a state change never restarts it (the motion eases across).
  const target = useRef({ state, level })
  target.current = { state, level }
  const redraw = useRef<(() => void) | null>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    // A canvas per run: a context given back on cleanup can't be had again from the same element (StrictMode remounts).
    const canvas = document.createElement('canvas')
    canvas.setAttribute('aria-hidden', 'true')
    canvas.style.width = `${size}px`
    canvas.style.height = `${size}px`
    canvas.style.gridArea = '1 / 1'
    host.prepend(canvas)
    const ctx = setup(canvas)
    if (!ctx) {
      canvas.remove()
      setFailed(true)
      return
    }
    const { gl, u } = ctx
    const dpr = Math.min(2, window.devicePixelRatio || 1)
    canvas.width = Math.round(size * dpr)
    canvas.height = Math.round(size * dpr)
    gl.viewport(0, 0, canvas.width, canvas.height)

    let tones = readTones(canvas)
    // A skin or theme change re-reads the tones.
    const skinHost = canvas.closest('[data-skin]') ?? document.documentElement
    const mo = new MutationObserver(() => (tones = readTones(canvas)))
    mo.observe(skinHost, { attributes: true, attributeFilter: ['data-skin', 'data-theme', 'class'] })
    if (skinHost !== document.documentElement) {
      mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })
    }

    const first = PARAMS[target.current.state]
    const cur = { ...first }
    let color: Rgb = tones[first.tone]
    let smoothLevel = 0
    let time = 0
    let last = performance.now()
    let raf = 0
    let visible = true
    const still = reducedMotion()

    const draw = (dt: number): void => {
      const goal = PARAMS[target.current.state]
      const k = still ? 1 : Math.min(1, dt * 5)
      for (const key of NUMERIC) cur[key] += (goal[key] - cur[key]) * k
      color = mix(color, tones[goal.tone], k)
      const raw = goal.react > 0 && target.current.level && !still ? Math.min(1, Math.max(0, target.current.level())) : 0
      smoothLevel += (raw * cur.react - smoothLevel) * Math.min(1, dt * 14)
      // Time runs faster with the level, so a loud voice churns the colour.
      time += dt * (0.6 + cur.flow * 0.4 + smoothLevel * 1.2)
      gl.uniform2f(u.uRes!, canvas.width, canvas.height)
      gl.uniform1f(u.uTime!, still ? 4.2 : time)
      gl.uniform1f(u.uLevel!, smoothLevel)
      gl.uniform1f(u.uFlow!, cur.flow)
      gl.uniform1f(u.uTurb!, cur.turb)
      gl.uniform1f(u.uSwirl!, cur.swirl)
      gl.uniform1f(u.uGlow!, cur.glow)
      gl.uniform1f(u.uDim!, cur.dim)
      gl.uniform1f(u.uBand!, cur.band)
      gl.uniform1f(u.uPulse!, cur.pulse)
      const pal = palette(color)
      gl.uniform3fv(u.uDeep!, pal.deep)
      gl.uniform3fv(u.uMid!, color)
      gl.uniform3fv(u.uLight!, pal.light)
      gl.uniform3fv(u.uAlt!, pal.alt)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (visible && !document.hidden) draw(dt)
      raf = requestAnimationFrame(tick)
    }

    if (still) {
      // One frame per state: the effect below redraws on a state change, the observer on a skin change.
      redraw.current = () => draw(1)
      draw(1)
      const mo2 = new MutationObserver(() => draw(1))
      mo2.observe(skinHost, { attributes: true, attributeFilter: ['data-skin', 'data-theme', 'class'] })
      return () => {
        redraw.current = null
        mo.disconnect()
        mo2.disconnect()
        gl.getExtension('WEBGL_lose_context')?.loseContext()
        canvas.remove()
      }
    }
    const io = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true))
    io.observe(canvas)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      mo.disconnect()
      // Contexts are few (~16 per page): give this one back.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }
  }, [size])

  // Reduced motion: a new still frame when the state changes.
  useEffect(() => redraw.current?.(), [state])

  if (failed) return <VoiceOrb state={state} size={size} level={level} />

  return (
    <span ref={hostRef} className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-live-orb={state}>
      {/* Muted and stopped also carry a mark, not only stillness and colour. */}
      <StateMark state={state} size={size} />
    </span>
  )
}
