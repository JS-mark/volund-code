<script setup lang="ts">
/* Plays the promo (./promo/Promo.vue) with a rAF clock synced to an <audio>
   element. The composition renders at a logical 1920x1080 and is scaled to fit
   the container. With ?promo-capture in the URL the player instead pins itself
   fullscreen and exposes window.volundPromoRender(t) so the offline capture
   script can drive frames deterministically. */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

import audioEn from '../assets/promo/audio-en.m4a'
/* Hashed asset imports: when assets are regenerated the URL changes, so
   browsers can never serve a stale poster/audio from cache. */
import audioZh from '../assets/promo/audio-zh.m4a'
import posterEn from '../assets/promo/volund-promo-en-poster.jpg'
import posterZh from '../assets/promo/volund-promo-zh-poster.jpg'
import Promo from './promo/Promo.vue'
import { DURATION_S } from './promo/timing'

const props = defineProps<{ locale: 'zh' | 'en' }>()

const LOGICAL_W = 1920
const LOGICAL_H = 1080

const capture = new URLSearchParams(location.search).has('promo-capture')

const wrap = ref<HTMLDivElement | null>(null)
const audioEl = ref<HTMLAudioElement | null>(null)
const time = ref(0)
const started = ref(false)
const playing = ref(false)
const muted = ref(false)
const scale = ref(0.5)
let raf = 0
let resizeObserver: ResizeObserver | null = null

const audioSrc = props.locale === 'zh' ? audioZh : audioEn
const posterSrc = props.locale === 'zh' ? posterZh : posterEn

onMounted(() => {
  if (capture) {
    Object.assign(window, {
      volundPromoRender: (t: number) => {
        time.value = t
      },
    })
    return
  }
  if (!wrap.value) return
  scale.value = wrap.value.clientWidth / LOGICAL_W
  resizeObserver = new ResizeObserver((entries) => {
    const w = entries[0]?.contentRect.width
    if (w) scale.value = w / LOGICAL_W
  })
  resizeObserver.observe(wrap.value)
})

const tick = () => {
  if (audioEl.value) time.value = Math.min(audioEl.value.currentTime, DURATION_S)
  raf = requestAnimationFrame(tick)
}

const play = () => {
  started.value = true
  playing.value = true
  void audioEl.value?.play()
  cancelAnimationFrame(raf)
  raf = requestAnimationFrame(tick)
}
const pause = () => {
  playing.value = false
  audioEl.value?.pause()
  cancelAnimationFrame(raf)
}
const toggle = () => (playing.value ? pause() : play())
const onEnded = () => {
  pause()
  started.value = false
  time.value = 0
}

const frac = computed(() => Math.min(1, time.value / DURATION_S))
const seek = (e: MouseEvent) => {
  const bar = e.currentTarget as HTMLElement
  const r = bar.getBoundingClientRect()
  const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width))
  if (audioEl.value) {
    audioEl.value.currentTime = f * DURATION_S
    time.value = f * DURATION_S
  }
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
const timeLabel = computed(() => `${fmt(time.value)} / ${fmt(DURATION_S)}`)

const toggleMute = () => {
  muted.value = !muted.value
  if (audioEl.value) audioEl.value.muted = muted.value
}
const fullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen()
  else void wrap.value?.requestFullscreen()
}

onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  resizeObserver?.disconnect()
})
</script>

<template>
  <!-- capture mode: pinned 1920x1080 canvas, clock driven externally -->
  <div v-if="capture" class="promo-capture">
    <Promo :t="time" :locale="locale" />
  </div>

  <div v-else ref="wrap" class="promo-player">
    <div class="promo-canvas" :style="{ transform: `scale(${scale})` }">
      <Promo :t="time" :locale="locale" />
    </div>

    <button
      v-if="!started"
      type="button"
      class="promo-poster"
      :style="{ backgroundImage: `url(${posterSrc})` }"
      :aria-label="locale === 'zh' ? '播放宣传视频' : 'Play the promo reel'"
      @click="play"
    >
      <span class="promo-play" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="30" height="30" fill="currentColor">
          <path d="M8 5.5v13l11-6.5z" />
        </svg>
      </span>
    </button>

    <div v-else class="promo-controls" @click.stop>
      <button type="button" class="ctl" :aria-label="playing ? 'Pause' : 'Play'" @click="toggle">
        <svg v-if="playing" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M7 5h4v14H7zM13 5h4v14h-4z" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M8 5.5v13l11-6.5z" />
        </svg>
      </button>
      <div class="progress" role="slider" :aria-valuenow="Math.round(frac * 100)" @click="seek">
        <div class="progress-fill" :style="{ width: `${frac * 100}%` }" />
      </div>
      <span class="time">{{ timeLabel }}</span>
      <button type="button" class="ctl" :aria-label="muted ? 'Unmute' : 'Mute'" @click="toggleMute">
        <svg v-if="muted" viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M4 9v6h4l5 5V4L8 9H4z" />
          <path d="M16 8l6 8M22 8l-6 8" stroke="currentColor" stroke-width="1.8" fill="none" />
        </svg>
        <svg v-else viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M4 9v6h4l5 5V4L8 9H4z" />
          <path
            d="M16.5 8.5a5 5 0 0 1 0 7M19 6a8.5 8.5 0 0 1 0 12"
            stroke="currentColor"
            stroke-width="1.8"
            fill="none"
          />
        </svg>
      </button>
      <button type="button" class="ctl" aria-label="Fullscreen" @click="fullscreen">
        <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
          <path d="M4 4h6v2H6v4H4zM14 4h6v6h-2V6h-4zM4 14h2v4h4v2H4zM18 14h2v6h-6v-2h4z" />
        </svg>
      </button>
    </div>

    <div v-if="started" class="promo-click-catcher" @click="toggle" />

    <audio ref="audioEl" :src="audioSrc" preload="auto" @ended="onEnded" />
  </div>
</template>

<style scoped>
.promo-capture {
  position: fixed;
  inset: 0;
  width: 1920px;
  height: 1080px;
  z-index: 9999;
  background: #0a0d0d;
  overflow: hidden;
}
.promo-player {
  position: relative;
  background: #0a0d0d;
  aspect-ratio: 16 / 9;
  overflow: hidden;
}
.promo-canvas {
  position: absolute;
  left: 0;
  top: 0;
  width: 1920px;
  height: 1080px;
  transform-origin: top left;
}
.promo-poster {
  position: absolute;
  inset: 0;
  width: 100%;
  padding: 0;
  border: 0;
  cursor: pointer;
  background-color: #0a0d0d;
  background-size: cover;
  background-position: center;
  z-index: 3;
}
.promo-play {
  position: absolute;
  left: 50%;
  top: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 4.4rem;
  height: 4.4rem;
  transform: translate(-50%, -50%);
  border-radius: 50%;
  color: #0a0d0d;
  background: #2bbd9b;
  box-shadow: 0 0 44px rgba(43, 189, 155, 0.45);
  transition: transform 160ms ease;
}
.promo-poster:hover .promo-play {
  transform: translate(-50%, -50%) scale(1.08);
}
.promo-click-catcher {
  position: absolute;
  inset: 0;
  z-index: 1;
  cursor: pointer;
}
.promo-controls {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 2;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  background: linear-gradient(transparent, rgba(10, 13, 13, 0.9));
  opacity: 0;
  transition: opacity 160ms ease;
}
.promo-player:hover .promo-controls {
  opacity: 1;
}
.ctl {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  color: #edf1e9;
  background: transparent;
  cursor: pointer;
}
.ctl:hover {
  background: rgba(43, 189, 155, 0.16);
}
.progress {
  flex: 1;
  height: 16px;
  display: flex;
  align-items: center;
  cursor: pointer;
  position: relative;
}
.progress::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: 6px;
  height: 4px;
  border-radius: 2px;
  background: rgba(237, 241, 233, 0.16);
}
.progress-fill {
  position: relative;
  z-index: 1;
  height: 4px;
  border-radius: 2px;
  background: #2bbd9b;
}
.time {
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 12px;
  color: #929b95;
  letter-spacing: 0.05em;
}
</style>
