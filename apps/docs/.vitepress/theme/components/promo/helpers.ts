export const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
export const seg = (t: number, a: number, b: number) => clamp01((t - a) / (b - a))
export const easeOut = (x: number) => 1 - Math.pow(1 - x, 3)
export const easeInOut = (x: number) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2)

/** Cross-fade window for a scene: fade in after `a`, fade out before `b`. */
export const sceneOpacity = (t: number, a: number, b: number, fadeIn = 0.5, fadeOut = 0.6) =>
  seg(t, a, a + fadeIn) * (1 - seg(t, b - fadeOut, b))
