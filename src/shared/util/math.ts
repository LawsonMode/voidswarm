export const TAU = Math.PI * 2;

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
/** Wrap angle to (-π, π]. */
export function wrapAngle(a: number): number {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
/** Shortest signed difference b - a in (-π, π]. */
export function angleDiff(a: number, b: number): number {
  return wrapAngle(b - a);
}
export function lerpAngle(a: number, b: number, t: number): number {
  return a + angleDiff(a, b) * t;
}
export function dist2(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  return dx * dx + dy * dy;
}
export function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.sqrt(dist2(ax, ay, bx, by));
}
export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}
/** Squared distance from point p to segment ab. */
export function segPointDist2(ax: number, ay: number, bx: number, by: number, px: number, py: number): number {
  const abx = bx - ax, aby = by - ay;
  const l2 = abx * abx + aby * aby;
  let t = l2 > 0 ? ((px - ax) * abx + (py - ay) * aby) / l2 : 0;
  t = clamp(t, 0, 1);
  const cx = ax + abx * t, cy = ay + aby * t;
  return dist2(cx, cy, px, py);
}
