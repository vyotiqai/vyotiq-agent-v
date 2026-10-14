/*
  The voice orb's looks (docs/voice-mode.md §25): the nine orbs from the
  "Agent V voice orbs" design canvas (https://claude.ai/artifact/9pifSoPQY6EsZXeuCy4ZrN,
  version 12), their shaders as the canvas runs them, with two inputs added
  for any size: Contour's line width follows uDpr and its line count uBands.
  The mockup in src/redesign/voice-view imports these; edit here.

  Every look takes the same inputs: uT (time), uLv (voice level 0..1), uTh
  (thinking 0..1), uSp (speaking 0..1), uTint (0..1 RGB) and uLight (1 on a
  light ground). Halftone also takes uCell (dot pitch in device px), Cloud
  uSize (point size). `base` is the token a look is coloured with when the
  state doesn't name one: the accent, or the text colour for the monochrome
  looks.

  Simplex noise inside: Ashima Arts / Stefan Gustavson (MIT).
*/

export type ShaderLookId = 'glow' | 'pearl' | 'aura' | 'wire' | 'cloud' | 'bubble' | 'halftone' | 'plasma' | 'contour'

export type ShaderLook = {
  label: string
  note: string
  base: 'accent' | 'fg'
  /** A point cloud: the vertex shader places this many points; additive on dark. */
  points?: number
  vs?: string
  /** Needs OES_standard_derivatives (fwidth). */
  derivatives?: boolean
  fs: string
}

export const SHADER_LOOKS: Record<ShaderLookId, ShaderLook> = {
  glow: {
    label: 'Glow',
    note: 'A soft gradient ball that spills light below it',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float px=2./min(uRes.x,uRes.y);float r=length(uv);
float R=.42+uLv*.06+.01*sin(uT*1.1);
vec2 q=uv-vec2(0.,.1);float rq=length(q);
float m=1.-smoothstep(R-px*1.5,R+px*1.5,rq);
float ang=uT*(.25+uTh*1.1)+uLv*.8;
vec2 dir=vec2(cos(ang),sin(ang));
float g=dot(q/R,dir)*.5+.5+.18*snoise(vec3(q*2.2,uT*.35));
vec3 c1=uTint;vec3 c2=hue(uTint,.5+uSp*.35);vec3 c3=hue(uTint,-.6);
vec3 col=mix(c1,c2,smoothstep(.1,.9,g));
col=mix(col,c3,smoothstep(.55,1.,1.-g)*.55);
float z=sqrt(max(0.,1.-rq*rq/(R*R)));
col*=.72+.38*z;
col=mix(col,vec3(1.),exp(-pow(length(q-vec2(-.13,.15)*R/.42),2.)*50.)*.5);
col=mix(col,hue(uTint,.4),pow(1.-z,3.)*.5);
float beam=exp(-pow(uv.x/(.38+uLv*.12),2.)-pow((uv.y+.5)/(.32+uLv*.08),2.))*.6;
float halo=exp(-max(0.,rq-R)*5.5)*.4;
float fade=smoothstep(1.,.72,r);
vec3 sc=clamp(c1,0.,1.)*(beam+halo)*(.8+uLv*.9)*(1.-m)*fade;
vec3 outc=clamp(col,0.,1.)*m+sc;
float al=clamp(m+max(sc.r,max(sc.g,sc.b)),0.,1.);
gl_FragColor=vec4(clamp(outc,0.,1.),al);}`
  },
  pearl: {
    label: 'Pearl',
    note: 'A frosted pearl with a ribbon of colour inside',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float r=length(uv);
float R=.58+uLv*.05+.008*sin(uT*1.2);
float m=1.-smoothstep(R-.03,R+.004,r);
vec3 col=mix(vec3(.99,.99,1.),vec3(.84,.85,.91),smoothstep(0.,R*1.15,length(uv-vec2(-.18,.22))));
float x=uv.x/R;
float amp=1.+uLv*1.6+uTh*.4;
float w1=.16*sin(x*2.4+uT*.9)+.07*snoise(vec3(x*1.4,uT*.3,1.))+.05*uTh*sin(x*6.-uT*3.);
float y=uv.y/R-w1*amp-.04;
float th=.09+.05*sin(x*3.+uT*.7)+uLv*.09;
float band=exp(-y*y/(th*th));
vec3 rc=clamp(hue(uTint,x*1.5+uT*.25+uSp*.9),0.,1.);
col=mix(col,rc,band*.88*smoothstep(1.02,.5,abs(x)));
float y2=uv.y/R+.26-.12*sin(x*1.8-uT*.7)*amp;
float band2=exp(-y2*y2/.018);
col=mix(col,clamp(hue(uTint,-x-uT*.2+2.),0.,1.),band2*.35*smoothstep(1.,.4,abs(x)));
col+=.22*exp(-pow(length(uv-vec2(-.2,.25)*R/.58),2.)*30.);
col*=1.-.12*smoothstep(.2,R,length(uv-vec2(.15,-.2)));
col=mix(col,vec3(1.),smoothstep(R-.07,R,r)*.4);
float shadow=exp(-pow((uv.y+R*1.1)/.045,2.)-pow(uv.x/(R*.7),2.))*.14*(1.-m);
float pool=shadow*mix(2.4,1.,uLight);
vec3 pc=mix(clamp(uTint,0.,1.),vec3(0.),uLight)*pool;
gl_FragColor=vec4(clamp(col,0.,1.)*m+pc,clamp(m+pool,0.,1.));}`
  },
  aura: {
    label: 'Aura',
    note: 'A ring of light with a crescent turning inside',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
float fbm(vec3 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*snoise(p);p*=2.;a*=.5;}return s;}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
// Light glows are emitted; on a light ground the same value is coverage of the tint, so a darker tint stays as opaque.
vec4 glow(vec3 c){float k=max(c.r,max(c.g,c.b));float tk=max(max(uTint.r,max(uTint.g,uTint.b)),.05);return vec4(c,mix(k,clamp(k/tk,0.,1.),uLight));}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float r=length(uv);float a=atan(uv.y,uv.x);
float R=.55+uLv*.05;
float ang=a+uT*(.2+uTh*1.2);
float wob=snoise(vec3(cos(ang)*1.2,sin(ang)*1.2,uT*.5))*(.012+uLv*.03)+snoise(vec3(cos(ang)*3.,sin(ang)*3.,uT*1.3))*uLv*.022;
float w=.03+.03*(.5+.5*snoise(vec3(cos(a)*2.,sin(a)*2.,uT*.7+5.)))+uLv*.03;
float dr=r-R-wob;
float ring=exp(-dr*dr/(w*w));
float core=exp(-dr*dr/(w*w*.06));
vec2 q=rot(uT*(.4+uTh*1.6))*uv;
float cr=exp(-pow((length(q-vec2(-.1,.04))-.28)/.07,2.))*smoothstep(-.3,.7,-q.x+q.y*.4)*(.55+uLv*.9);
float hz=(fbm(vec3(uv*2.,uT*.2))*.5+.5)*smoothstep(R+.05,0.,r)*.22;
vec3 c1=clamp(uTint,0.,1.);vec3 c2=clamp(hue(uTint,.9),0.,1.);vec3 c3=clamp(hue(uTint,-.7+uSp*.4),0.,1.);
vec3 hot=mix(vec3(1.),c1*.55,uLight);
vec3 col=c1*ring*.95+mix(c2,hot,.55)*core*.95+mix(c3,hot,.25)*cr+c2*hz*(1.-.6*uLight);
col+=c1*exp(-max(0.,r-R)*7.)*.22*(1.+uLv)*smoothstep(1.,.78,r)*mix(1.,smoothstep(R-.12,R,r),uLight);
col=clamp(col,0.,1.);
gl_FragColor=glow(col);}`
  },
  wire: {
    label: 'Wire',
    note: 'Threads of light circling an empty centre',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
// Light glows are emitted; on a light ground the same value is coverage of the tint, so a darker tint stays as opaque.
vec4 glow(vec3 c){float k=max(c.r,max(c.g,c.b));float tk=max(max(uTint.r,max(uTint.g,uTint.b)),.05);return vec4(c,mix(k,clamp(k/tk,0.,1.),uLight));}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float px=2./min(uRes.x,uRes.y);float r=length(uv);float a=atan(uv.y,uv.x);
float R=.56+uLv*.04;
float acc=0.;
for(int i=0;i<7;i++){
float fi=float(i);
float aa=a+uT*uTh*(.3+.1*fi);
float n=snoise(vec3(cos(aa)*1.2+fi*3.1,sin(aa)*1.2,uT*(.3+.07*fi)+fi));
float n2=snoise(vec3(cos(aa)*3.+fi,sin(aa)*3.,uT*.9+fi*2.));
float rr=R+n*(.045+uLv*.11+uTh*.03)+n2*(.01+uLv*.03);
float d=abs(r-rr);
float line=px*1.1/(d+px*.7);
line*=line;
float fade=.5+.5*sin(a*2.+fi*1.7+uT*.6);
acc+=line*(.25+.75*fade)*.22;
}
acc+=exp(-pow((r-R)/.14,2.))*.1*(1.+uLv*1.5);
acc*=smoothstep(1.,.85,r)*(1.+.8*uLight);
vec3 tint=clamp(hue(uTint,uSp*.45),0.,1.);
vec3 col=mix(tint*acc,mix(vec3(acc),tint*.6*acc,uLight),clamp(acc-.6,0.,1.));
col=clamp(col,0.,1.);
gl_FragColor=glow(col);}`
  },
  cloud: {
    label: 'Cloud',
    note: 'Four thousand points on a turning sphere',
    base: 'fg',
    points: 4200,
    vs: `attribute vec3 aP;attribute float aR;
uniform float uT,uLv,uTh,uSp,uSize;
varying float vA;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
void main(){
vec3 p=aP;
float n=snoise(p*1.7+vec3(0.,0.,uT*.35));
float n2=snoise(p*4.+vec3(uT*.6));
float disp=1.+n*(.07+uLv*.25+uTh*.05)+n2*uLv*.06+(aR-.5)*(.03+uTh*.06)+uSp*(.015+uLv*.07)*sin(aP.y*9.-uT*6.);
p*=disp;
p.xz=rot(uT*(.15+uTh*.7))*p.xz;
p.yz=rot(.38)*p.yz;
gl_Position=vec4(p.xy*.6,0.,1.);
gl_PointSize=uSize*(1.2+(p.z*.5+.5)*1.1)*(1.+uLv*.35);
vA=(.25+.75*(p.z*.5+.5))*(.55+.45*aR);
}`,
    fs: `precision highp float;
uniform float uLight;uniform vec3 uTint;
varying float vA;
void main(){vec2 c=gl_PointCoord-.5;float d=length(c);float a=smoothstep(.5,.1,d)*vA*.75;gl_FragColor=vec4(clamp(uTint,0.,1.)*a,a);}`
  },
  bubble: {
    label: 'Bubble',
    note: 'A soap-film bubble with a band of light',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
float fbm(vec3 p){float s=0.,a=.5;for(int i=0;i<4;i++){s+=a*snoise(p);p*=2.;a*=.5;}return s;}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float px=2./min(uRes.x,uRes.y);float r=length(uv);float a=atan(uv.y,uv.x);
float R=.56+uLv*.04+.006*sin(uT*1.7);
float Rr=R+snoise(vec3(cos(a)*1.4,sin(a)*1.4,uT*.4))*(.01+uLv*.03);
float inside=1.-smoothstep(Rr-px,Rr+px,r);
float rn=clamp(r/Rr,0.,1.);
float rim=pow(rn,7.);
float thick=fbm(vec3(uv*1.2,uT*.2))*.5+.5+uTh*.18*sin(a*2.+uT*1.6);
vec3 film=.5+.5*cos(6.2832*(thick*1.1+vec3(0.,.33,.67))+uT*.25);
film=mix(mix(vec3(dot(film,vec3(.333))),film,.6+.4*uLight),clamp(uTint,0.,1.),.2);
film*=1.-.45*uLight;
vec3 col=film*(rim*.85+.035)*inside;
float bx=uv.x/Rr;
float by=uv.y/Rr+.035*sin(bx*3.+uT*.8)+.025*uTh*sin(bx*8.-uT*3.);
float bw=.05+uLv*.06+uSp*.02;
float band=exp(-by*by/(bw*bw))*smoothstep(1.,.25,abs(bx))*inside;
vec3 bc=mix(clamp(hue(uTint,2.6),0.,1.),clamp(uTint,0.,1.),smoothstep(-.7,.7,bx));
col+=bc*band*(.5+uLv*.9);
col+=bc*exp(-by*by/(.05+uLv*.06))*smoothstep(1.,.1,abs(bx))*inside*(.16+uLv*.2);
col+=mix(vec3(1.,.95,.88),bc*.55,uLight)*exp(-by*by/(bw*bw*.06))*band*(.55+uLv*.5);
vec2 hp=(uv-vec2(-.24,.28)*Rr/.56)*vec2(1.7,2.6);
col+=vec3(1.)*exp(-dot(hp,hp)*70.)*.6*inside*(1.-uLight);
col+=film*pow(rn,12.)*smoothstep(.1,.9,dot(uv/max(r,1e-4),vec2(.6,-.8)))*.5*inside;
col+=film*exp(-pow((r-Rr)/(px*1.5),2.))*.45;
col=clamp(col,0.,1.);
gl_FragColor=vec4(col,max(col.r,max(col.g,col.b)));}`
  },
  halftone: {
    label: 'Halftone',
    note: 'A dot-matrix sphere lit from one side',
    base: 'fg',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp,uCell;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
void main(){
vec2 g=floor(gl_FragCoord.xy/uCell)*uCell+.5*uCell;
vec2 cuv=(g-.5*uRes)/(.5*min(uRes.x,uRes.y));
float R=.6+uLv*.04;
float rr=length(cuv);
float on=step(rr,R);
vec3 n=vec3(cuv/R,sqrt(max(0.,1.-dot(cuv,cuv)/(R*R))));
float la=uT*(.35+uTh*.9);
vec3 L=normalize(vec3(cos(la)*.85,.3+.2*sin(la*.7),.65+.3*sin(la)));
float lam=max(0.,dot(n,L));
float tex=snoise(n*2.2+vec3(0.,0.,uT*.3))*.5+.5;
float wave=mix(sin(n.y*14.-uT*7.),sin(rr/R*16.-uT*8.),uSp);
float b=lam*.8+tex*(.22+uLv*.45)+uLv*.28*(.5+.5*wave);
b=max(clamp(b,0.,1.),.16)*on;
float rad=.5*uCell*mix(.1,.5,b);
float d=length(gl_FragCoord.xy-g);
float dt=(1.-smoothstep(rad-1.,rad+.5,d))*step(.02,b);
vec3 col=mix(clamp(uTint,0.,1.)*.55,clamp(uTint,0.,1.),b)*dt;
gl_FragColor=vec4(col,dt);}`
  },
  plasma: {
    label: 'Plasma',
    note: 'Filaments of light inside a glass sphere',
    base: 'accent',
    fs: `precision highp float;
uniform vec2 uRes;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
vec3 hue(vec3 c,float a){const vec3 k=vec3(.57735);float ca=cos(a);return c*ca+cross(k,c)*sin(a)+k*dot(k,c)*(1.-ca);}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float px=2./min(uRes.x,uRes.y);float r=length(uv);float a=atan(uv.y,uv.x);
float R=.55+uLv*.04;
float Rr=R+snoise(vec3(cos(a)*1.3,sin(a)*1.3,uT*.5))*(.008+uLv*.03);
float m=1.-smoothstep(Rr-px*1.5,Rr+px*1.5,r);
vec3 n=vec3(uv/Rr,sqrt(max(0.,1.-r*r/(Rr*Rr))));
float sp=uT*(.3+uTh*1.)+uLv*.5;
vec3 p=n*1.8+vec3(sp*.3,0.,sp*.2);
float ridge=pow(1.-abs(snoise(p+vec3(0.,0.,sp))),6.);
float ridge2=pow(1.-abs(snoise(p*1.9-vec3(sp*.5))),8.);
float fil=ridge*.9+ridge2*.6;
vec3 c1=clamp(uTint,0.,1.);vec3 c2=clamp(hue(uTint,-.9),0.,1.);vec3 c3=clamp(hue(uTint,.8+uSp*.4),0.,1.);
vec3 col=mix(c1*.18,c2*.45,n.z);
col+=mix(c3,vec3(1.),.4)*fil*(.9+uLv*1.6);
col+=vec3(1.,.96,1.)*exp(-r*r/(.035+uLv*.05))*(.55+uLv*.9);
col+=c1*pow(1.-n.z,3.)*1.2;
col=clamp(col,0.,1.)*m;
col+=c1*exp(-max(0.,r-Rr)*8.)*(.35+uLv*.5)*(1.-m)*smoothstep(1.,.8,r);
col=clamp(col,0.,1.);
gl_FragColor=vec4(col,clamp(m+max(col.r,max(col.g,col.b))*(1.-m),0.,1.));}`
  },
  contour: {
    label: 'Contour',
    note: 'Contour lines flowing over a turning sphere',
    base: 'accent',
    derivatives: true,
    fs: `#extension GL_OES_standard_derivatives : enable
precision highp float;
uniform vec2 uRes;uniform float uDpr,uBands;uniform float uLight,uT,uLv,uTh,uSp;uniform vec3 uTint;
vec3 m289(vec3 x){return x-floor(x*(1./289.))*289.;}
vec4 m289(vec4 x){return x-floor(x*(1./289.))*289.;}
vec4 pm(vec4 x){return m289(((x*34.)+1.)*x);}
float snoise(vec3 v){const vec2 C=vec2(1./6.,1./3.);const vec4 D=vec4(0.,.5,1.,2.);vec3 i=floor(v+dot(v,C.yyy));vec3 x0=v-i+dot(i,C.xxx);vec3 g=step(x0.yzx,x0.xyz);vec3 l=1.-g;vec3 i1=min(g.xyz,l.zxy);vec3 i2=max(g.xyz,l.zxy);vec3 x1=x0-i1+C.xxx;vec3 x2=x0-i2+C.yyy;vec3 x3=x0-D.yyy;i=m289(i);vec4 p=pm(pm(pm(i.z+vec4(0.,i1.z,i2.z,1.))+i.y+vec4(0.,i1.y,i2.y,1.))+i.x+vec4(0.,i1.x,i2.x,1.));float n_=.142857142857;vec3 ns=n_*D.wyz-D.xzx;vec4 j=p-49.*floor(p*ns.z*ns.z);vec4 x_=floor(j*ns.z);vec4 y_=floor(j-7.*x_);vec4 x=x_*ns.x+ns.yyyy;vec4 y=y_*ns.x+ns.yyyy;vec4 h=1.-abs(x)-abs(y);vec4 b0=vec4(x.xy,y.xy);vec4 b1=vec4(x.zw,y.zw);vec4 s0=floor(b0)*2.+1.;vec4 s1=floor(b1)*2.+1.;vec4 sh=-step(h,vec4(0.));vec4 a0=b0.xzyw+s0.xzyw*sh.xxyy;vec4 a1=b1.xzyw+s1.xzyw*sh.zzww;vec3 p0=vec3(a0.xy,h.x);vec3 p1=vec3(a0.zw,h.y);vec3 p2=vec3(a1.xy,h.z);vec3 p3=vec3(a1.zw,h.w);vec4 nr=1.79284291400159-.85373472095314*vec4(dot(p0,p0),dot(p1,p1),dot(p2,p2),dot(p3,p3));p0*=nr.x;p1*=nr.y;p2*=nr.z;p3*=nr.w;vec4 m=max(.6-vec4(dot(x0,x0),dot(x1,x1),dot(x2,x2),dot(x3,x3)),0.);m=m*m;return 42.*dot(m*m,vec4(dot(p0,x0),dot(p1,x1),dot(p2,x2),dot(p3,x3)));}
mat2 rot(float a){float c=cos(a),s=sin(a);return mat2(c,-s,s,c);}
// Light glows are emitted; on a light ground the same value is coverage of the tint, so a darker tint stays as opaque.
vec4 glow(vec3 c){float k=max(c.r,max(c.g,c.b));float tk=max(max(uTint.r,max(uTint.g,uTint.b)),.05);return vec4(c,mix(k,clamp(k/tk,0.,1.),uLight));}
void main(){
vec2 uv=(gl_FragCoord.xy-.5*uRes)/(.5*min(uRes.x,uRes.y));float px=2./min(uRes.x,uRes.y);float r=length(uv);float s=uDpr;
float R=.6+uLv*.04;
float m=1.-smoothstep(R-px*1.5,R+px*1.5,r);
float z0=sqrt(max(0.,1.-r*r/(R*R)));
vec3 n=vec3(uv/R,z0);
n.xz=rot(uT*(.2+uTh*.7))*n.xz;
vec3 q=n*1.1+vec3(0.,uT*.1,0.);
float h=snoise(q)*.65+snoise(q*2.03+7.)*.22;
float k=(h*(.9+uLv*.6)+n.y*1.2+uSp*.12*sin(uT*2.6+n.x*5.))*uBands;
float w=max(fwidth(k),1e-4);
float d=abs(fract(k+.5)-.5)/w;
float hw=(.55+uLv*.9)*s;
float line=(1.-smoothstep(hw-.5,hw+.8,d))*smoothstep(.5,.22,w);
float major=1.-step(.5,mod(floor(k+.5),5.));
float shade=.3+.7*z0;
vec3 tint=clamp(uTint,0.,1.);
vec3 col=tint*line*shade*(.55+.45*major)*m+tint*.035*m;
col+=tint*pow(1.-z0,4.)*.25*m;
col+=tint*exp(-max(0.,r-R)*9.)*.25*(1.-m)*smoothstep(1.,.85,r);
col=clamp(col,0.,1.);
gl_FragColor=glow(col);}`
  },
}
