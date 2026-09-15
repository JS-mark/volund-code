<script setup lang="ts">
import { computed } from 'vue'

import type { PromoCopy } from '../copy'
import { easeOut, sceneOpacity, seg } from '../helpers'
import { C, FONT_MONO } from '../theme'
import { SCENES } from '../timing'

const props = defineProps<{ t: number; copy: PromoCopy }>()

const [a, b] = SCENES.opening
const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b, 0.3, 0.6) }))
const glowStyle = computed(() => ({ opacity: 0.5 + 0.5 * Math.sin(props.t * 2.0) }))

/* Logo sub-paths assemble one by one. */
const partStyle = (i: number) => {
  const pr = easeOut(seg(props.t, 0.25 + i * 0.22, 0.75 + i * 0.22))
  return {
    opacity: pr,
    transform: `scale(${0.6 + 0.4 * pr})`,
    transformBox: 'fill-box',
    transformOrigin: 'center',
  }
}

const wm = computed(() => easeOut(seg(props.t, 1.5, 2.2)))
const tg = computed(() => easeOut(seg(props.t, 2.3, 3.0)))
const bd = computed(() => easeOut(seg(props.t, 3.1, 3.7)))
</script>

<template>
  <section class="scene center" :style="wrapStyle">
    <div class="logo-wrap">
      <div class="logo-glow" :style="glowStyle" />
      <svg viewBox="0 0 64 64" width="220" height="220" class="logo">
        <g :style="partStyle(0)"><rect width="64" height="64" rx="8" fill="#0d1512" /></g>
        <g :style="partStyle(1)">
          <path fill="#2bbd9b" d="M10 7H54V13H60V40H54V46H37V59H27V46H10V40H4V13H10Z" />
        </g>
        <g :style="partStyle(2)"><rect x="14" y="17" width="36" height="19" fill="#0d1512" /></g>
        <g :style="partStyle(3)">
          <path
            fill="#2bbd9b"
            d="M18 20H22V23H25V26H28V29H25V32H22V35H18V32H21V29H24V26H21V23H18Z"
          />
        </g>
        <g :style="partStyle(4)"><rect x="34" y="32" width="10" height="3" fill="#2bbd9b" /></g>
      </svg>
    </div>
    <div
      class="wordmark"
      :style="{
        opacity: wm,
        transform: `translateY(${(1 - wm) * 26}px)`,
        letterSpacing: `${0.34 + (1 - wm) * 0.12}em`,
      }"
    >
      VOLUND<span :style="{ color: C.accent }">&nbsp;CLI</span>
    </div>
    <div class="tagline" :style="{ opacity: tg, transform: `translateY(${(1 - tg) * 18}px)` }">
      {{ copy.tagline }}
    </div>
    <div class="oss-badge" :style="{ opacity: bd, transform: `translateY(${(1 - bd) * 14}px)` }">
      {{ copy.ossBadge }}
    </div>
  </section>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
}
.center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.logo-wrap {
  position: relative;
  width: 220px;
  height: 220px;
}
.logo-glow {
  position: absolute;
  inset: -140px;
  border-radius: 50%;
  background: radial-gradient(circle, rgba(43, 189, 155, 0.28) 0%, transparent 65%);
}
.logo {
  position: relative;
}
.logo g {
  transform-box: fill-box;
}
.wordmark {
  margin-top: 56px;
  font-family: v-bind(FONT_MONO);
  font-size: 74px;
  font-weight: 700;
  text-indent: 0.34em;
}
.tagline {
  margin-top: 26px;
  font-size: 34px;
  color: v-bind('C.muted');
  letter-spacing: 0.08em;
}
.oss-badge {
  margin-top: 44px;
  font-family: v-bind(FONT_MONO);
  font-size: 20px;
  letter-spacing: 0.3em;
  color: v-bind('C.accent');
  border: 1px solid rgba(43, 189, 155, 0.35);
  border-radius: 999px;
  padding: 12px 30px;
}
</style>
