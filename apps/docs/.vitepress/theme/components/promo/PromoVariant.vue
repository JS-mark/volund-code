<script setup lang="ts">
/* Delivery variant of the promo (social cuts): reuses the Promo composition
   as-is and only (a) remaps the variant clock through the variant's cut list
   (variants.json — an edit list over the site timeline) and (b) provides the
   layout flavor so scenes can restack for 9:16. All scene content, copy and
   timing stay single-sourced in the site files. */
import { computed, provide } from 'vue'

import { COPY, type Locale } from './copy'
import Promo from './Promo.vue'
import { C, FONT_SANS } from './theme'
import { PROMO_LAYOUT, VARIANTS, mapVariantTime, type VariantId } from './variants'

const props = defineProps<{ t: number; locale: Locale; variant: VariantId }>()

const def = computed(() => VARIANTS[props.variant])
provide(PROMO_LAYOUT, def.value.layout)

const siteT = computed(() => mapVariantTime(def.value, props.t))
const rootStyle = computed(() => ({
  width: `${def.value.w}px`,
  height: `${def.value.h}px`,
  background: C.ink,
  color: C.text,
  fontFamily: FONT_SANS,
}))
</script>

<template>
  <div class="promo-variant" :style="rootStyle">
    <Promo :t="siteT" :locale="locale" />
  </div>
</template>

<style scoped>
.promo-variant {
  position: relative;
  overflow: hidden;
}
</style>
