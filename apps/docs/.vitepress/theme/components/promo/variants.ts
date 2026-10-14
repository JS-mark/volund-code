import type { InjectionKey } from 'vue'

import data from './variants.json'

export type PromoLayout = 'wide' | 'vertical'

export type VariantId = keyof typeof data

/** One cut plays the site composition (timing.ts timeline) from `from` to `to`,
    starting at variant time `at`. Segments always run at native speed — cuts
    are an edit list, so the original audio can be spliced the same way. */
export interface PromoCut {
  scene: string
  from: number
  to: number
  at: number
}

export interface PromoVariantDef {
  /** Logical canvas size (capture viewport). */
  w: number
  h: number
  /** Scene layout flavor: `wide` keeps the site geometry, `vertical` restacks it. */
  layout: PromoLayout
  cuts: PromoCut[]
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON inference widens `layout` to string
export const VARIANTS = data as Record<VariantId, PromoVariantDef>

/** Scenes read this to pick up vertical overrides; Promo.vue (site) never
    provides it, so the embedded player keeps the `wide` default untouched. */
export const PROMO_LAYOUT: InjectionKey<PromoLayout> = Symbol('promoLayout')

export const variantDuration = (v: PromoVariantDef) => {
  const last = v.cuts[v.cuts.length - 1]
  return last.at + (last.to - last.from)
}

/** Map variant time → site composition time through the cut list. */
export const mapVariantTime = (v: PromoVariantDef, vt: number) => {
  for (const cut of v.cuts) {
    if (vt < cut.at + (cut.to - cut.from)) return cut.from + Math.max(0, vt - cut.at)
  }
  return v.cuts[v.cuts.length - 1].to
}
