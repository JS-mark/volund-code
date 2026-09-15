<script setup lang="ts">
import { computed } from 'vue'

import type { PromoCopy } from '../copy'
import { easeOut, sceneOpacity, seg } from '../helpers'
import { C, FONT_MONO, bigTitleStyle, eyebrowStyle } from '../theme'
import { SCENES } from '../timing'

const props = defineProps<{ t: number; copy: PromoCopy }>()

const [a, b] = SCENES.features
const local = computed(() => props.t - a)
const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b) }))
const ti = computed(() => easeOut(seg(local.value, 0.3, 1.0)))
const cardStyle = (i: number) => {
  const ca = easeOut(seg(local.value, 1.1 + i * 0.45, 1.9 + i * 0.45))
  return {
    opacity: ca,
    transform: `translateY(${(1 - ca) * 40}px) scale(${0.96 + 0.04 * ca})`,
  }
}
</script>

<template>
  <section class="scene" :style="wrapStyle">
    <span class="eyebrow" :style="{ ...eyebrowStyle, opacity: easeOut(seg(local, 0.1, 0.7)) }">
      {{ copy.featEyebrow }}
    </span>
    <h2 :style="{ ...bigTitleStyle, opacity: ti, transform: `translateY(${(1 - ti) * 30}px)` }">
      {{ copy.featTitle[0] }}<br /><span class="dim">{{ copy.featTitle[1] }}</span>
    </h2>
    <div class="grid2">
      <div v-for="(f, i) in copy.features" :key="f[0]" class="card" :style="cardStyle(i)">
        <span class="fi">A / 0{{ i + 1 }}</span>
        <h3>{{ f[0] }}</h3>
        <p>{{ f[1] }}</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0 190px;
}
.dim {
  color: v-bind('C.muted');
}
.grid2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 34px;
  margin-top: 72px;
}
.card {
  border: 1px solid v-bind('C.line');
  background: v-bind('C.surface');
  border-radius: 18px;
  padding: 42px 46px;
}
.fi {
  font-family: v-bind(FONT_MONO);
  font-size: 18px;
  color: v-bind('C.accent');
  letter-spacing: 0.24em;
}
.card h3 {
  font-size: 42px;
  margin-top: 16px;
  font-weight: 700;
}
.card p {
  font-size: 24px;
  color: v-bind('C.muted');
  margin-top: 12px;
  line-height: 1.65;
}
</style>
