/** Review-only choreography adapted from Firaz's supplied full-body study:
 * /Users/firazfhansurie/.codex/worktrees/bos-mascot-polish/src/full-body-mascot-preview.ts
 * Keyframes and outline→circle approach retained. The retained CursorAvatar
 * engine supplies the frame loop, expressive face, clipping and interruption.
 * No production activity wiring is enabled by this module. */
export type MascotGesture = "idle" | "thinking" | "searching" | "working" | "waiting" | "finished";
export type GesturePose = { m: number; sx: number; sy: number; dx: number; dy: number; rotate: number; split: number; gx: number; gy: number; eye: number; face: number };
export const IDLE_POSE: GesturePose = { m: 0, sx: 1, sy: 1, dx: 0, dy: 0, rotate: 0, split: 0, gx: 0, gy: 0, eye: 1, face: 1 };
type Key = [number, Partial<GesturePose>];
export const GESTURE_TIMING = { thinking: [1600, 3000], searching: [1200, 2500], working: [1800, 2800], waiting: [800, 5000], finished: [900, 0], idle: [0, 0] } as const;
const timelines: Record<Exclude<MascotGesture, "idle">, Key[]> = {
  thinking: [[0,{}],[.1,{}],[.24,{sx:.9,sy:1.18,dy:-4,gy:-6}],[.36,{rotate:-13,sx:.96,sy:1.08,gx:-4,gy:-5}],[.49,{m:1,sy:1,sx:1,dy:2,face:.75,eye:.4}],[.61,{m:1,face:.75,gx:3,gy:-4}],[.76,{rotate:5,sx:1.04,sy:.97}],[.9,{}],[1,{}]],
  searching: [[0,{}],[.1,{}],[.26,{sx:1.2,sy:.88,dx:-7,rotate:-8,gx:-12}],[.38,{sx:1.1,sy:.95,dx:-5,gx:-10}],[.5,{}],[.67,{sx:1.2,sy:.88,dx:7,rotate:8,gx:12}],[.77,{sx:1.08,sy:.94,dx:4,gx:9}],[.9,{sx:.98,sy:1.03}],[1,{}]],
  working: [[0,{}],[.12,{sx:1.08,sy:.9}],[.24,{m:1,face:.44,split:1}],[.74,{m:1,face:.44,split:1}],[.85,{m:1,face:.7,split:0}],[.94,{sx:1.04,sy:.97}],[1,{}]],
  waiting: [[0,{}],[.12,{sx:.96,sy:1.04}],[.35,{sx:1.25,sy:.25,dy:0,eye:.75}],[1,{sx:1.25,sy:.25,dy:0,eye:.75}]],
  finished: [[0,{}],[.14,{sx:1.14,sy:.78,dy:3,eye:.55}],[.36,{sx:.86,sy:1.15,dy:-19,rotate:-17,eye:1.1}],[.53,{sx:.96,sy:1.04,dy:-13,rotate:12}],[.69,{sx:1.2,sy:.75,dy:3,eye:.35}],[.79,{sx:.96,sy:1.06,dy:-2}],[.9,{}],[1,{}]],
};

const ease = (t: number) => { const c = Math.max(0, Math.min(1, t)); return c*c*(3-2*c); };
export function mixPose(a: GesturePose, b: GesturePose, fraction: number): GesturePose {
  if (fraction <= 0) return { ...a };
  if (fraction >= 1) return { ...b };
  const t = ease(fraction), out = { ...IDLE_POSE };
  for (const key of Object.keys(out) as (keyof GesturePose)[]) out[key] = a[key] + (b[key] - a[key]) * t;
  return out;
}
function sample(state: Exclude<MascotGesture, "idle">, t: number): GesturePose {
  const keys = timelines[state], index = keys.findIndex(([at]) => at >= t);
  if (index <= 0) return { ...IDLE_POSE, ...(index < 0 ? keys.at(-1)![1] : keys[0][1]) };
  const [at0,p0] = keys[index-1], [at1,p1] = keys[index];
  return mixPose({ ...IDLE_POSE, ...p0 }, { ...IDLE_POSE, ...p1 }, (t-at0)/(at1-at0));
}
export function gesturePose(state: MascotGesture, elapsed: number, reduced = false): GesturePose {
  if (state === "idle") return { ...IDLE_POSE };
  if (reduced) return state === "finished" ? { ...IDLE_POSE } : sample(state, state === "waiting" ? 1 : .36);
  const [duration, pause] = GESTURE_TIMING[state];
  if (state === "finished") return elapsed >= duration ? { ...IDLE_POSE } : sample(state, elapsed/duration);
  if (state === "waiting") {
    const settled = sample("waiting", Math.min(1, elapsed/900));
    if (elapsed > 900) {
      const phase = (elapsed - 900) % pause;
      const perk = phase < duration ? Math.sin(phase/duration*Math.PI)**2 : 0;
      settled.sy += perk*.08; settled.gy -= perk*4;
    }
    return settled;
  }
  const phase = Math.max(0, elapsed) % (duration + pause);
  return phase >= duration ? { ...IDLE_POSE } : sample(state, phase/duration);
}

export interface GestureActivity { working?: boolean; waiting?: boolean; thinking?: boolean; searching?: boolean; terminalTurnId?: string | null; reconnect?: boolean }
export interface GestureReceipt { gesture: MascotGesture; terminalTurnId: string | null }
export function resolveGesture(activity: GestureActivity, previous: GestureReceipt): GestureReceipt {
  const terminalTurnId = activity.terminalTurnId ?? previous.terminalTurnId;
  const finished = !!activity.terminalTurnId && activity.terminalTurnId !== previous.terminalTurnId && !activity.reconnect;
  return { gesture: activity.waiting ? "waiting" : activity.working ? "working" : activity.searching ? "searching" : activity.thinking ? "thinking" : finished ? "finished" : "idle", terminalTurnId };
}

// The canonical catalog is absolute M/C/Z. Sample its cubic outline once,
// then reuse the supplied study's perimeter→circle morph. No animation loop here.
type Point = [number, number];
const outlines = new Map<string, { points: Point[]; angle: number; winding: number }>();
function outline(path: string) {
  const cached = outlines.get(path); if (cached) return cached;
  const chunks = [...path.matchAll(/([MC])\s*([^MCZ]+)/g)];
  const dense: Point[] = []; let last: Point = [50, 50];
  for (const [,command,values] of chunks) {
    const n = values.match(/-?\d+(?:\.\d+)?/g)!.map(Number);
    if (command === "M") { last = [n[0], n[1]]; dense.push(last); continue; }
    for (let j=0;j<n.length;j+=6) {
      const a=last, b:Point=[n[j],n[j+1]], c:Point=[n[j+2],n[j+3]], d:Point=[n[j+4],n[j+5]];
      for(let i=1;i<=24;i++) { const t=i/24,u=1-t; dense.push([u*u*u*a[0]+3*u*u*t*b[0]+3*u*t*t*c[0]+t*t*t*d[0],u*u*u*a[1]+3*u*u*t*b[1]+3*u*t*t*c[1]+t*t*t*d[1]]); }
      last=d;
    }
  }
  dense.push(dense[0]); const distance=[0];
  for(let i=1;i<dense.length;i++) distance.push(distance[i-1]+Math.hypot(dense[i][0]-dense[i-1][0],dense[i][1]-dense[i-1][1]));
  let segment=1;
  const points=Array.from({length:128},(_,i):Point=> { const target=i*distance.at(-1)!/128; while(segment<distance.length-1&&distance[segment]<target)segment++;const t=(target-distance[segment-1])/(distance[segment]-distance[segment-1]||1),a=dense[segment-1],b=dense[segment];return [a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t]; });
  const area=points.reduce((sum,p,i)=>{const q=points[(i+1)%points.length];return sum+p[0]*q[1]-q[0]*p[1];},0);
  const result={points,angle:Math.atan2(points[0][1]-50,points[0][0]-50),winding:area>=0?1:-1};outlines.set(path,result);return result;
}
export function morphBodyPath(path: string, amount: number, radius = 28): string {
  if (amount <= .00001) return path;
  const { points, angle, winding }=outline(path), m=Math.max(0,Math.min(1,amount));
  return points.map(([x,y],i)=> { const a=angle+winding*i/points.length*Math.PI*2;return `${i?"L":"M"}${(x*(1-m)+(50+Math.cos(a)*radius)*m).toFixed(3)},${(y*(1-m)+(50+Math.sin(a)*radius)*m).toFixed(3)}`; }).join(" ")+" Z";
}
