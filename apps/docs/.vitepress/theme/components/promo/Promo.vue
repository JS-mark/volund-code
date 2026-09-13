<script setup lang="ts">
import { computed } from 'vue'
import { C, FONT_SANS } from './theme'
import { COPY, type Locale } from './copy'
import Opening from './scenes/Opening.vue'
import TerminalScene from './scenes/TerminalScene.vue'
import ControlPlane from './scenes/ControlPlane.vue'
import Features from './scenes/Features.vue'
import Ecosystem from './scenes/Ecosystem.vue'
import Cta from './scenes/Cta.vue'

const props = defineProps<{ t: number; locale: Locale }>()
const copy = computed(() => COPY[props.locale])

const gridStyle = computed(() => ({
  transform: `translate(${-props.t * 6}px, ${-props.t * 3}px)`,
}))
const glowStyle = computed(() => ({
  transform: `translate(${Math.sin(props.t * 0.35) * 60}px, ${Math.cos(props.t * 0.28) * 40}px)`,
}))
</script>

<template>
  <div class="promo-root" :style="{ background: C.ink, color: C.text, fontFamily: FONT_SANS }">
    <div class="grid" :style="gridStyle" />
    <div class="glow" :style="glowStyle" />
    <div class="glow2" />
    <Opening :t="t" :copy="copy" />
    <TerminalScene :t="t" :locale="locale" :copy="copy" />
    <ControlPlane :t="t" :copy="copy" />
    <Features :t="t" :copy="copy" />
    <Ecosystem :t="t" :copy="copy" />
    <Cta :t="t" :copy="copy" />
  </div>
</template>

<style scoped>
.promo-root {
  position: relative;
  width: 100%;
  height: 100%;
  overflow: hidden;
}
.grid {
  position: absolute;
  inset: -120px;
  background-image:
    linear-gradient(90deg, rgba(43, 189, 155, 0.05) 1px, transparent 1px),
    linear-gradient(rgba(43, 189, 155, 0.05) 1px, transparent 1px);
  background-size: 72px 72px;
}
.glow {
  position: absolute;
  width: 1400px;
  height: 1400px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(43, 189, 155, 0.1) 0%, transparent 62%);
  left: 260px;
  top: -240px;
}
.glow2 {
  position: absolute;
  width: 1000px;
  height: 1000px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(85, 215, 185, 0.05) 0%, transparent 60%);
  right: -200px;
  bottom: -300px;
}
</style>
