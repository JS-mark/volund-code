<script setup lang="ts">
import { computed } from 'vue'

import type { PromoCopy } from '../copy'
import { clamp01, easeOut, sceneOpacity, seg } from '../helpers'
import { C, FONT_MONO, bigTitleStyle, eyebrowStyle } from '../theme'
import { SCENES } from '../timing'

const props = defineProps<{ t: number; copy: PromoCopy }>()

const [a, b] = SCENES.control
const local = computed(() => props.t - a)
const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b) }))
const ti = computed(() => easeOut(seg(local.value, 0.3, 1.1)))
const sb = computed(() => easeOut(seg(local.value, 0.9, 1.6)))

/* Fixed rail geometry: 4 × 300px nodes, evenly spaced in a 1480px row.
   No connector bars — the travelling pulse alone carries the flow. */
const NODE_W = 300
const RAIL_W = 1480
const GAP_W = (RAIL_W - 4 * NODE_W) / 3
const nodeCenterX = (i: number) => i * (NODE_W + GAP_W) + NODE_W / 2

const pt = computed(() => (local.value - 3.4) % 2.6)
const pulseActive = computed(() => local.value > 3.4)
const pulseP = computed(() => clamp01(pt.value / 2.2))
const pulseX = computed(() => pulseP.value * (RAIL_W - 22))

const nodeStyle = (i: number) => {
  const na = easeOut(seg(local.value, 1.6 + i * 0.35, 2.3 + i * 0.35))
  const glow = pulseActive.value && Math.abs(pulseX.value + 11 - nodeCenterX(i)) < NODE_W / 2
  return {
    opacity: na,
    transform: `translateY(${(1 - na) * 30}px)`,
    borderColor: glow ? 'rgba(43,189,155,0.65)' : C.line,
    boxShadow: glow ? '0 0 44px rgba(43,189,155,0.18)' : 'none',
  }
}
const pulseStyle = computed(() => ({
  left: `${pulseX.value}px`,
  opacity: pulseActive.value && pulseP.value < 0.98 ? 1 : 0,
}))
</script>

<template>
  <section class="scene" :style="wrapStyle">
    <span class="eyebrow" :style="{ ...eyebrowStyle, opacity: easeOut(seg(local, 0.1, 0.7)) }">
      {{ copy.controlEyebrow }}
    </span>
    <h2 :style="{ ...bigTitleStyle, opacity: ti, transform: `translateY(${(1 - ti) * 34}px)` }">
      {{ copy.controlTitle[0] }}<br /><span class="dim">{{ copy.controlTitle[1] }}</span>
    </h2>
    <p class="sub" :style="{ opacity: sb, transform: `translateY(${(1 - sb) * 22}px)` }">
      {{ copy.controlSub[0] }}<br />{{ copy.controlSub[1] }}
    </p>
    <div class="rail" :style="{ width: `${RAIL_W}px` }">
      <div v-for="(node, i) in copy.rail" :key="node[0]" class="node" :style="nodeStyle(i)">
        <span class="idx">0{{ i + 1 }}</span>
        <strong>{{ node[0] }}</strong>
        <small>{{ node[1] }}</small>
      </div>
      <div class="pulse" :style="pulseStyle" />
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
.sub {
  margin-top: 26px;
  font-size: 28px;
  color: v-bind('C.muted');
  max-width: 1100px;
  line-height: 1.7;
}
.rail {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 84px;
  position: relative;
}
.node {
  width: 300px;
  padding: 34px 30px 30px;
  border-radius: 16px;
  background: v-bind('C.surface');
  border: 1px solid v-bind('C.line');
  position: relative;
  z-index: 2;
}
.idx {
  font-family: v-bind(FONT_MONO);
  font-size: 18px;
  color: v-bind('C.accent');
  letter-spacing: 0.2em;
}
.node strong {
  display: block;
  font-size: 40px;
  margin-top: 12px;
}
.node small {
  display: block;
  font-size: 21px;
  color: v-bind('C.muted');
  margin-top: 8px;
}
.pulse {
  position: absolute;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: v-bind('C.accentStrong');
  z-index: 3;
  top: 50%;
  margin-top: -11px;
  box-shadow: 0 0 26px rgba(85, 215, 185, 0.9);
}
</style>
