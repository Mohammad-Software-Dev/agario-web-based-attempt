export type Vec2 = { x: number; y: number };

export const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
export const distanceSq = (a: Vec2, b: Vec2) => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};
export const length = (v: Vec2) => Math.hypot(v.x, v.y);
export const normalize = (v: Vec2): Vec2 => {
  const len = length(v);
  return len > 0.0001 ? { x: v.x / len, y: v.y / len } : { x: 0, y: 0 };
};
export const radiusFromMass = (mass: number) => Math.sqrt(Math.max(1, mass)) * 4;
export const speedFromMass = (mass: number, baseSpeed: number) => baseSpeed / Math.pow(Math.max(10, mass), 0.12);
export const randomBetween = (min: number, max: number) => min + Math.random() * (max - min);
