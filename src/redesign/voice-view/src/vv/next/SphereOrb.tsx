import { useEffect, useRef, useState } from 'react'
import type { VoiceSessionState } from '@shared/voiceSession'
import { VoiceOrb } from '@renderer/features/voice/VoiceOrb'
import { reducedMotion, readTokens, StateMark, type Rgb } from '@renderer/features/voice/orb/orbShared'

/*
  The redesign's orb (2026-10-15 pick: "liquid sphere"): a glossy ball of
  fluid in the skin's accent, lit from the top left. A sphere normal, bent by
  a slowly moving liquid surface, gives it diffuse light, a specular glint and
  a lit rim, so it reads as an object, not a gradient. It swells, stretches and
  splashes with your voice, a ring of light breathing out around it; while it speaks, rings travel out across its surface and waves run
  round its edge. Each state is its own motion (WCAG 1.4.1): a calm drift
  while listening, a churn while thinking, a band of light circling while the
  task works, a slow swell when it needs you; muted and stopped go still and
  grey and carry a mark. State changes ease over ~300 ms.

  Colour comes from the skin's tokens (a shader can't take var()); one tone
  makes the palette, deeper for shade and lighter for light, so it holds in
  every skin and theme, and re-reads when either changes.

  Cost: one canvas at ≤2× DPR, paused offscreen and in a hidden window; one
  still frame per state under reduced motion. No WebGL falls back to the
  drawn orb; so does anything under 40px, where a sphere is a dot.
*/

type Tone = 'accent' | 'muted' | 'warning' | 'danger' | 'tertiary'

type Params = {
  tone: Tone
  /** How fast the surface flows. */
  flow: number
  /** How much the surface and edge wobble on their own. */
  turb: number
  /** Rings across the surface and waves round the edge (speech). */
  ripple: number
  /** Light outside the edge. */
  glow: number
  /** Towards grey. */
  dim: number
  /** A band of light circling the rim (work happening elsewhere). */
  band: number
  /** A slow swell of the whole sphere. */
  pulse: number
  /** How much the voice level moves it. */
  react: number
  /** A ring of light outside the edge that pulses with the level. */
  halo: number
}

const P = (tone: Tone, p: Partial<Omit<Params, 'tone'>>): Params => ({ tone, flow: 0, turb: 0, ripple: 0, glow: 0, dim: 0, band: 0, pulse: 0, react: 0, halo: 0, ...p })

const PARAMS: Record<VoiceSessionState, Params> = {
  off: P('tertiary', { dim: 0.6 }),
  connecting: P('muted', { flow: 0.35, glow: 0.12, dim: 0.35, pulse: 1, halo: 0.3 }),
  listening: P('accent', { flow: 0.45, turb: 0.1, glow: 0.32, pulse: 0.5, halo: 0.3 }),
  hearing: P('accent', { flow: 1, turb: 0.35, ripple: 0.3, glow: 0.55, react: 1, halo: 1 }),
  thinking: P('accent', { flow: 2.4, turb: 0.4, glow: 0.42, pulse: 0.3, halo: 0.2 }),
  working: P('accent', { flow: 0.6, turb: 0.08, glow: 0.26, dim: 0.05, band: 1 }),
  speaking: P('accent', { flow: 1.3, turb: 0.25, ripple: 1, glow: 0.65, react: 1, halo: 1 }),
  waiting_on_you: P('accent', { flow: 0.5, turb: 0.1, glow: 0.7, pulse: 1.6, halo: 0.8 }),
  paused: P('muted', { flow: 0.1, dim: 0.85 }),
  reconnecting: P('warning', { flow: 0.4, turb: 0.15, glow: 0.2, dim: 0.1, band: 0.8, pulse: 0.5, halo: 0.3 }),
  error: P('danger', { flow: 0.15, glow: 0.22, dim: 0.05 })
}

const NUMERIC = ['flow', 'turb', 'ripple', 'glow', 'dim', 'band', 'pulse', 'react', 'halo'] as const

const TONE_VAR: Record<Tone, string> = {
  accent: '--vy-accent',
  muted: '--vy-muted',
  warning: '--vy-warning',
  danger: '--vy-danger',
  tertiary: '--vy-tertiary'
}

const VERT = 'attribute vec2 p;void main(){gl_Position=vec4(p,0.,1.);}'

// Simplex noise: Ashima Arts / Stefan Gustavson (MIT).
const FRAG = `precision highp float;
uniform vec2 uRes;uniform float uTime,uLevel,uFlow,uTurb,uRipple,uGlow,uDim,uBand,uPulse,uHalo;
uniform vec3 uDeep,uMid,uLight;
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
  // It swells with the level and the pulse, and stretches a little upwards on a loud syllable.
  uv.y*=1.-uLevel*.07;uv.x*=1.+uLevel*.03;
  r=length(uv);a=atan(uv.y,uv.x);
  float base=.56+uPulse*.035*sin(t*2.)+uLevel*.16;
  // The edge: a slow wobble, lobes that splash out with the voice, and waves running round it while it speaks.
  float wob=snoise(vec3(cos(a)*1.2,sin(a)*1.2,t*.3*(uFlow+.2)));
  float lobe=snoise(vec3(cos(a)*2.2,sin(a)*2.2,t*1.6));
  float wav=sin(a*6.+t*5.)*sin(a*3.-t*3.1);
  float radius=base+wob*(.006+uTurb*.03+uLevel*.04)+lobe*uLevel*.05+wav*uRipple*(.01+uLevel*.03);
  float aa=1.5/half_;
  float inside=1.-smoothstep(radius-aa,radius+aa,r);
  // A sphere's normal, bent by the liquid surface and by rings travelling out from the middle.
  vec2 q=uv/radius;float rr=min(dot(q,q),1.);
  vec3 n=vec3(q,sqrt(1.-rr));
  float ft=t*.4*(uFlow+.15);
  vec2 g=vec2(snoise(vec3(q*1.6,ft)),snoise(vec3(q*1.6+5.2,ft+3.1)));
  float ring=sin(sqrt(rr)*18.-t*7.)*uRipple*(.35+uLevel*.65)*(1.-rr);
  n.xy+=g*(.16+uTurb*.25)+(q/(sqrt(rr)+1e-3))*ring*.2;
  n=normalize(n);
  vec3 L=normalize(vec3(-.45,.55,.75));
  float dif=clamp(dot(n,L),0.,1.);
  float spec=pow(clamp(dot(n,normalize(L+vec3(0.,0.,1.))),0.,1.),48.);
  float fres=pow(1.-n.z,2.5);
  // Shade to light by the lamp, a caustic drifting inside, a lit rim and the glint.
  float caust=smoothstep(.55,1.,snoise(vec3(q*2.4+vec2(0.,ft),ft*1.3))*.5+.5);
  vec3 col=mix(uDeep,uMid,dif*.9+.1);
  col=mix(col,uLight,caust*.28*(1.-rr));
  col=mix(col,uLight,fres*.5);
  col+=spec*mix(vec3(1.),uLight,.3)*.8;
  // Working: a band of light circling the rim.
  float da=atan(sin(a-t*1.6),cos(a-t*1.6));
  col=mix(col,uLight,clamp(uBand*exp(-da*da*4.)*smoothstep(.6,1.,rr)*.9,0.,1.));
  col=mix(col,vec3(dot(col,vec3(.299,.587,.114))),uDim);
  float d=max(0.,r-radius);
  // Fades to nothing before the canvas edge, so it never shows a square.
  float glow=exp(-d*7.)*uGlow*(.5+uLevel)*(1.-inside)*smoothstep(.98,.7,r);
  // A thin ring outside the edge that breathes out with the level.
  float ringR=radius*(1.16+uLevel*.08)+.012*sin(t*2.2);
  float halo=exp(-pow((r-ringR)*30.,2.))*uHalo*(.22+uLevel*.78)*(1.-inside)*smoothstep(.99,.85,r);
  glow+=halo*.9;
  gl_FragColor=vec4(clamp(col,0.,1.)*inside+mix(uMid,uLight,.35)*glow,clamp(inside+glow,0.,1.));
}`

const mix = (a: Rgb, b: Rgb, k: number): Rgb => [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k]

/** Deeper and lighter steps of one tone: towards black for shade, towards white for light. */
function palette(tone: Rgb): { deep: Rgb; light: Rgb } {
  return { deep: mix(tone, [0, 0, 0], 0.55), light: mix(tone, [1, 1, 1], 0.62) }
}

type Gl = { gl: WebGLRenderingContext; u: Record<string, WebGLUniformLocation | null> }

const UNIFORMS = ['uRes', 'uTime', 'uLevel', 'uFlow', 'uTurb', 'uRipple', 'uGlow', 'uDim', 'uBand', 'uPulse', 'uHalo', 'uDeep', 'uMid', 'uLight'] as const

function setup(canvas: HTMLCanvasElement): Gl | null {
  const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: false })
  if (!gl) return null
  const shader = (type: number, src: string): WebGLShader | null => {
    const s = gl.createShader(type)
    if (!s) return null
    gl.shaderSource(s, src)
    gl.compileShader(s)
    if (gl.getShaderParameter(s, gl.COMPILE_STATUS)) return s
    console.warn('[orb] sphere shader did not compile; using the drawn orb', gl.getShaderInfoLog(s))
    return null
  }
  const vs = shader(gl.VERTEX_SHADER, VERT)
  const fs = shader(gl.FRAGMENT_SHADER, FRAG)
  const prog = vs && fs ? gl.createProgram() : null
  if (!vs || !fs || !prog) return null
  gl.attachShader(prog, vs)
  gl.attachShader(prog, fs)
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null
  gl.useProgram(prog)
  gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer())
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW)
  const loc = gl.getAttribLocation(prog, 'p')
  gl.enableVertexAttribArray(loc)
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0)
  const u: Gl['u'] = {}
  for (const name of UNIFORMS) u[name] = gl.getUniformLocation(prog, name)
  return { gl, u }
}

export const MIN_SPHERE_SIZE = 40

export function SphereOrb({ state, size, level }: { state: VoiceSessionState; size: number; level?: () => number }) {
  const hostRef = useRef<HTMLSpanElement>(null)
  const [failed, setFailed] = useState(false)
  // Read inside the loop, so a state change never restarts it (the motion eases across).
  const target = useRef({ state, level })
  target.current = { state, level }
  const redraw = useRef<(() => void) | null>(null)
  const small = size < MIN_SPHERE_SIZE

  useEffect(() => {
    const host = hostRef.current
    if (!host || small) return
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

    let tones = readTokens(canvas, TONE_VAR)
    const skinHost = canvas.closest('[data-skin]') ?? document.documentElement
    const still = reducedMotion()
    const cur = { ...PARAMS[target.current.state] }
    let color: Rgb = tones[cur.tone]
    let smoothLevel = 0
    let time = 0
    let last = performance.now()
    let raf = 0
    let visible = true

    const draw = (dt: number): void => {
      const goal = PARAMS[target.current.state]
      const k = still ? 1 : Math.min(1, dt * 5)
      for (const key of NUMERIC) cur[key] += (goal[key] - cur[key]) * k
      color = mix(color, tones[goal.tone], k)
      const raw = goal.react > 0 && target.current.level && !still ? Math.min(1, Math.max(0, target.current.level())) : 0
      smoothLevel += (raw * cur.react - smoothLevel) * Math.min(1, dt * 16)
      time += dt * (0.6 + cur.flow * 0.4 + smoothLevel * 1.1)
      const pal = palette(color)
      gl.uniform2f(u.uRes!, canvas.width, canvas.height)
      gl.uniform1f(u.uTime!, still ? 4.2 : time)
      gl.uniform1f(u.uLevel!, smoothLevel)
      gl.uniform1f(u.uFlow!, cur.flow)
      gl.uniform1f(u.uTurb!, cur.turb)
      gl.uniform1f(u.uRipple!, cur.ripple)
      gl.uniform1f(u.uGlow!, cur.glow)
      gl.uniform1f(u.uDim!, cur.dim)
      gl.uniform1f(u.uBand!, cur.band)
      gl.uniform1f(u.uPulse!, cur.pulse)
      gl.uniform1f(u.uHalo!, cur.halo)
      gl.uniform3fv(u.uDeep!, pal.deep)
      gl.uniform3fv(u.uMid!, color)
      gl.uniform3fv(u.uLight!, pal.light)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4)
    }

    // A skin or theme change re-reads the tones (and redraws the still frame).
    const mo = new MutationObserver(() => {
      tones = readTokens(canvas, TONE_VAR)
      if (still) draw(1)
    })
    mo.observe(skinHost, { attributes: true, attributeFilter: ['data-skin', 'data-theme', 'class'] })
    if (skinHost !== document.documentElement) mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-skin', 'data-theme'] })

    const release = (): void => {
      mo.disconnect()
      // Contexts are few (~16 per page): give this one back.
      gl.getExtension('WEBGL_lose_context')?.loseContext()
      canvas.remove()
    }

    if (still) {
      redraw.current = () => draw(1)
      draw(1)
      return () => {
        redraw.current = null
        release()
      }
    }
    const tick = (now: number): void => {
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      if (visible && !document.hidden) draw(dt)
      raf = requestAnimationFrame(tick)
    }
    const io = new IntersectionObserver(([entry]) => (visible = entry?.isIntersecting ?? true))
    io.observe(canvas)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      io.disconnect()
      release()
    }
  }, [size, small])

  // Reduced motion: a new still frame when the state changes.
  useEffect(() => redraw.current?.(), [state])

  if (failed || small) return <VoiceOrb state={state} size={size} level={level} />

  return (
    <span ref={hostRef} className="relative inline-grid shrink-0 place-items-center" style={{ width: size, height: size }} data-sphere-orb={state}>
      {/* Muted and stopped also carry a mark, not only stillness and colour. */}
      <StateMark state={state} size={size} />
    </span>
  )
}
