<script setup lang="ts">
import { computed } from 'vue'
import { C, FONT_MONO, bigTitleStyle, eyebrowStyle } from '../theme'
import { easeOut, sceneOpacity, seg } from '../helpers'
import { SCENES } from '../timing'
import type { PromoCopy } from '../copy'

const props = defineProps<{ t: number; copy: PromoCopy }>()

const [a, b] = SCENES.ecosystem
const local = computed(() => props.t - a)
const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b) }))
const ti = computed(() => easeOut(seg(local.value, 0.3, 1.0)))
const stripStyle = (i: number) => {
  const sa = easeOut(seg(local.value, 1.2 + i * 0.8, 2.1 + i * 0.8))
  return { opacity: sa, transform: `translateX(${(1 - sa) * 60}px)` }
}
</script>

<template>
  <section class="scene" :style="wrapStyle">
    <span class="eyebrow" :style="{ ...eyebrowStyle, opacity: easeOut(seg(local, 0.1, 0.7)) }">
      {{ copy.ecoEyebrow }}
    </span>
    <h2 :style="{ ...bigTitleStyle, opacity: ti, transform: `translateY(${(1 - ti) * 30}px)` }">
      {{ copy.ecoTitle[0] }}<br /><span class="dim">{{ copy.ecoTitle[1] }}</span>
    </h2>
    <div class="strips">
      <div v-for="(s, i) in copy.strips" :key="s[0]" class="strip" :style="stripStyle(i)">
        <span class="num">0{{ i + 1 }}</span>
        <strong>{{ s[0] }}</strong>
        <span class="desc">{{ s[1] }}</span>
        <svg
          v-if="i === 0"
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <path d="M3 8h18M7 6h.01M10 6h.01" />
        </svg>
        <svg
          v-else-if="i === 1"
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <rect x="7" y="2" width="10" height="20" rx="2" />
          <path d="M11 18h2" />
        </svg>
        <svg
          v-else
          class="icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="1.6"
        >
          <path d="M14 7l-8.5 8.5a2.1 2.1 0 0 0 3 3L17 10" />
          <path d="M16 3l5 5-3 3-5-5z" />
        </svg>
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
.strips {
  margin-top: 72px;
  display: flex;
  flex-direction: column;
  gap: 26px;
}
.strip {
  display: flex;
  align-items: center;
  gap: 40px;
  border: 1px solid v-bind('C.line');
  background: v-bind('C.surface');
  border-radius: 16px;
  padding: 34px 44px;
}
.num {
  font-family: v-bind(FONT_MONO);
  font-size: 22px;
  color: v-bind('C.accent');
  letter-spacing: 0.2em;
  width: 90px;
}
.strip strong {
  font-size: 36px;
  width: 420px;
}
.desc {
  font-size: 24px;
  color: v-bind('C.muted');
  flex: 1;
}
.icon {
  width: 44px;
  height: 44px;
  color: v-bind('C.accentStrong');
  flex-shrink: 0;
}
</style>
