<script setup lang="ts">
import { computed } from 'vue'
import { C, FONT_MONO } from '../theme'
import { easeOut, sceneOpacity, seg } from '../helpers'
import { INSTALL, SCENES } from '../timing'
import type { PromoCopy } from '../copy'

const props = defineProps<{ t: number; copy: PromoCopy }>()

const [a, b] = SCENES.cta
const local = computed(() => props.t - a)
const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b, 0.6, 0.55) }))
const lr = computed(() => easeOut(seg(local.value, 0.2, 1.0)))
const cl = computed(() => easeOut(seg(local.value, 0.7, 1.5)))
const inst = computed(() => easeOut(seg(local.value, 1.6, 2.1)))
const bg = computed(() => easeOut(seg(local.value, 3.4, 4.1)))
const gh = computed(() => easeOut(seg(local.value, 4.1, 4.8)))

const typed = computed(() => {
  const n = Math.max(0, Math.floor((local.value - INSTALL.startLocal) * INSTALL.cps))
  return INSTALL.text.slice(0, Math.min(n, INSTALL.text.length))
})
const cursorOn = computed(
  () => local.value > INSTALL.startLocal - 0.4 && Math.floor(props.t * 2.2) % 2 === 0,
)
</script>

<template>
  <section class="scene" :style="wrapStyle">
    <div class="logo-row" :style="{ opacity: lr, transform: `translateY(${(1 - lr) * 24}px)` }">
      <svg viewBox="0 0 64 64" width="96" height="96">
        <rect width="64" height="64" rx="8" fill="#0d1512" />
        <path fill="#2bbd9b" d="M10 7H54V13H60V40H54V46H37V59H27V46H10V40H4V13H10Z" />
        <rect x="14" y="17" width="36" height="19" fill="#0d1512" />
        <path
          fill="#2bbd9b"
          d="M18 20H22V23H25V26H28V29H25V32H22V35H18V32H21V29H24V26H21V23H18Z"
        />
        <rect x="34" y="32" width="10" height="3" fill="#2bbd9b" />
      </svg>
      <span class="wm">VOLUND CLI</span>
    </div>
    <div class="claim" :style="{ opacity: cl, transform: `translateY(${(1 - cl) * 30}px)` }">
      {{ copy.ctaClaim[0] }} <span class="dim">{{ copy.ctaClaim[1] }}</span>
    </div>
    <div class="install" :style="{ opacity: inst, transform: `translateY(${(1 - inst) * 20}px)` }">
      <span class="p">$</span>
      <code>{{ typed }}</code>
      <span class="cursor" :style="{ opacity: cursorOn ? 1 : 0 }" />
    </div>
    <div class="badges" :style="{ opacity: bg, transform: `translateY(${(1 - bg) * 16}px)` }">
      <span v-for="x in copy.badges" :key="x">{{ x }}</span>
    </div>
    <div class="gh" :style="{ opacity: gh }">{{ copy.github }}</div>
  </section>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
}
.logo-row {
  display: flex;
  align-items: center;
  gap: 28px;
}
.wm {
  font-family: v-bind(FONT_MONO);
  font-size: 54px;
  font-weight: 700;
  letter-spacing: 0.3em;
}
.claim {
  margin-top: 54px;
  font-size: 84px;
  font-weight: 700;
}
.dim {
  color: v-bind('C.muted');
}
.install {
  margin-top: 60px;
  display: flex;
  align-items: center;
  gap: 16px;
  font-family: v-bind(FONT_MONO);
  font-size: 32px;
  background: #0d1110;
  border: 1px solid v-bind('C.line');
  border-radius: 14px;
  padding: 26px 40px;
}
.p {
  color: v-bind('C.accent');
}
.cursor {
  display: inline-block;
  width: 16px;
  height: 34px;
  background: v-bind('C.accent');
  vertical-align: -6px;
}
.badges {
  margin-top: 44px;
  display: flex;
  gap: 18px;
}
.badges span {
  font-family: v-bind(FONT_MONO);
  font-size: 19px;
  color: v-bind('C.muted');
  border: 1px solid v-bind('C.line');
  border-radius: 999px;
  padding: 10px 24px;
  letter-spacing: 0.06em;
}
.gh {
  margin-top: 40px;
  font-family: v-bind(FONT_MONO);
  font-size: 24px;
  color: v-bind('C.accentStrong');
  letter-spacing: 0.08em;
}
</style>
