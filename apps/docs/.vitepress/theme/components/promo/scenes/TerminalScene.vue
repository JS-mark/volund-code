<script setup lang="ts">
import { computed } from 'vue'
import { FONT_MONO } from '../theme'
import { easeOut, sceneOpacity, seg } from '../helpers'
import { SCENES, TERM } from '../timing'
import type { Locale, PromoCopy } from '../copy'
import plan from '../typing-plan.json'

const props = defineProps<{ t: number; locale: Locale; copy: PromoCopy }>()

const [a, b] = SCENES.terminal
const typing = plan[props.locale]

const wrapStyle = computed(() => ({ opacity: sceneOpacity(props.t, a, b) }))
const scale = computed(() => 0.965 + 0.035 * easeOut(seg(props.t, a, a + 1.0)))
const capOpacity = computed(
  () =>
    seg(props.t, TERM.captionIn, TERM.captionIn + 0.8) *
    (1 - seg(props.t, TERM.captionOut, TERM.captionOut + 0.7)),
)

/* Terminal palette mirroring the real ink TUI (MessageBlock / ActivityBlock /
   PermissionPromptStack): green `>` user marker, cyan ⏺ assistant, gray ◆
   activity rows that dim when done, yellow permission header. */
const K = {
  green: '#2bbd9b',
  cyan: '#55d7b9',
  blue: '#7ab8e8',
  red: '#e06c5b',
  yellow: '#e0b25b',
  gray: '#929b95',
  text: '#edf1e9',
  dim: 'rgba(146, 155, 149, 0.75)',
}

const typedText = (text: string, start: number, cps: number) => {
  const n = Math.max(0, Math.floor((props.t - start) * cps))
  return text.slice(0, Math.min(n, text.length))
}
const typedVisible = (start: number) => (props.t >= start - 0.3 ? 1 : 0)
const cursorOn = (text: string, start: number, cps: number) => {
  const n = Math.max(0, Math.floor((props.t - start) * cps))
  const done = n >= text.length
  const blink = Math.floor(props.t * 2.2) % 2 === 0
  return props.t >= start - 0.3 && blink && (!done || props.t < start + text.length / cps + 0.8)
}

const rowIn = (at: number) => {
  const p = easeOut(seg(props.t, at, at + 0.35))
  return { opacity: p, transform: `translateY(${(1 - p) * 10}px)` }
}

/* Permission card: the focused pointer moves 1 → 2 shortly before approval,
   then the card collapses into a one-line system note. */
const focusedIdx = computed(() => (props.t >= 14.4 ? 1 : 0))
const approved = computed(() => props.t >= TERM.permApprove)
const cardOut = computed(() => 1 - seg(props.t, TERM.permApprove, TERM.permApprove + 0.22))
const cardStyle = computed(() => {
  const p = easeOut(seg(props.t, TERM.permAt, TERM.permAt + 0.45))
  return { opacity: p * cardOut.value, transform: `translateY(${(1 - p) * 12}px)` }
})
const optStyle = (i: number) => {
  const opt = props.copy.term.permOptions[i]
  const focused = i === focusedIdx.value && !approved.value
  return {
    color: focused ? K[opt.color] : K.text,
    fontWeight: focused ? 700 : 400,
    background: focused ? 'rgba(43, 189, 155, 0.08)' : 'transparent',
  }
}
const approvedIn = computed(() => easeOut(seg(props.t, TERM.permApprove, TERM.permApprove + 0.4)))
</script>

<template>
  <section class="scene" :style="wrapStyle">
    <div class="term" :style="{ transform: `scale(${scale})` }">
      <div class="term-bar">
        <div class="dots">
          <i :style="{ background: K.red }" /><i :style="{ background: K.yellow }" /><i
            :style="{ background: K.green }"
          />
        </div>
        <span class="term-title">volund · ~/workspace</span>
        <span class="term-tier">TIER / FULL</span>
      </div>
      <div class="term-body">
        <!-- shell invocation: ❯ volund "…" (mint prompt, white command) -->
        <div class="row" :style="{ opacity: typedVisible(typing.cmd1Start) }">
          <span class="mk" :style="{ color: K.green }">❯</span>
          <span :style="{ color: K.text }">{{
            typedText(typing.cmd1, typing.cmd1Start, typing.cmd1Cps)
          }}</span
          ><span
            class="cursor"
            :style="{ opacity: cursorOn(typing.cmd1, typing.cmd1Start, typing.cmd1Cps) ? 1 : 0 }"
          />
        </div>

        <!-- assistant: ⏺ cyan -->
        <div class="row" :style="rowIn(9.8)">
          <span class="mk" :style="{ color: K.cyan }">⏺</span>
          <span :style="{ color: K.text, fontWeight: 700 }">{{ copy.term.assistant1 }}</span>
        </div>
        <div class="row" :style="rowIn(10.9)">
          <span class="mk" /><span :style="{ color: K.text }">{{ copy.term.assistant2 }}</span>
        </div>

        <!-- activity: ◆ rows, dim once done -->
        <div class="row act" :style="rowIn(8.9)">
          <span class="mk" :style="{ color: K.gray }">◆</span>
          <span :style="{ color: K.gray }">{{ copy.term.readDone }}<span class="sfx"> · 1.1s</span></span>
        </div>
        <div class="row act" :style="rowIn(11.8)">
          <span class="mk" :style="{ color: K.gray }">◆</span>
          <span :style="{ color: K.gray }">{{ copy.term.editDone }}<span class="sfx"> · +8 −3 · 0.6s</span></span>
        </div>

        <!-- permission card mirroring PermissionPromptStack -->
        <div v-if="!approved" class="perm" :style="cardStyle">
          <div>
            <span :style="{ color: K.yellow, fontWeight: 700 }">{{ copy.term.permTitle }}</span>
            <span :style="{ color: K.text, fontWeight: 700 }"> · {{ copy.term.permTool }}</span>
          </div>
          <div>
            <span :style="{ color: K.yellow }">{{ copy.term.permSpecGutter }}</span
            ><span>{{ copy.term.permFile }}</span
            ><span :style="{ color: K.gray }">{{ copy.term.permSpecSuffix }}</span>
          </div>
          <div
            v-for="(opt, i) in copy.term.permOptions"
            :key="opt.label"
            class="opt"
            :style="optStyle(i)"
          >
            <span class="ptr" :style="{ color: i === focusedIdx ? K[opt.color] : 'transparent' }">&gt;</span>
            <span class="num">{{ i + 1 }}</span>
            <span class="lbl">{{ opt.label }}</span>
            <span class="hint" :style="{ color: K.gray }">{{ opt.hint }}</span>
          </div>
          <div class="foot" :style="{ color: K.gray }">{{ copy.term.permFooter }}</div>
          <div class="foot" :style="{ color: K.dim }">{{ copy.term.permSecondary }}</div>
        </div>
        <!-- approved: card collapses to a system line -->
        <div
          v-if="approved"
          class="row"
          :style="{
            opacity: approvedIn,
            transform: `translateY(${(1 - approvedIn) * 10}px)`,
          }"
        >
          <span class="mk" :style="{ color: K.green }">·</span>
          <span :style="{ color: K.gray }">{{ copy.term.permApproved }}</span>
        </div>

        <div class="row act" :style="rowIn(16.2)">
          <span class="mk" :style="{ color: K.gray }">◆</span>
          <span :style="{ color: K.gray }">{{ copy.term.testDone }}<span class="sfx"> · 5/5 ✓ · 1.8s</span></span>
        </div>
        <div class="row" :style="rowIn(17.2)">
          <span class="mk" :style="{ color: K.cyan }">⏺</span>
          <span :style="{ color: K.text, fontWeight: 700 }">{{ copy.term.assistant3 }}</span>
        </div>

        <!-- follow-up typed at the input prompt -->
        <div class="row" :style="{ opacity: typedVisible(typing.cmd2Start) }">
          <span class="mk" :style="{ color: K.green }">&gt;</span>
          <span :style="{ color: K.gray }">{{
            typedText(typing.cmd2, typing.cmd2Start, typing.cmd2Cps)
          }}</span
          ><span
            class="cursor"
            :style="{ opacity: cursorOn(typing.cmd2, typing.cmd2Start, typing.cmd2Cps) ? 1 : 0 }"
          />
        </div>
        <div class="row act" :style="rowIn(21.0)">
          <span class="mk" :style="{ color: K.gray }">◆</span>
          <span :style="{ color: K.gray }">{{ copy.term.commitDone }}<span class="sfx"> · a3f9c21 · 0.9s</span></span>
        </div>
      </div>
    </div>
    <div class="caption" :style="{ opacity: capOpacity }">
      {{ copy.term.captionPre }}<span :style="{ color: K.cyan }">{{ copy.term.captionHl }}</span>
    </div>
  </section>
</template>

<style scoped>
.scene {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}
.term {
  width: 1380px;
  border-radius: 18px;
  background: #0d1110;
  border: 1px solid #262e2b;
  box-shadow:
    0 60px 140px rgba(0, 0, 0, 0.6),
    0 0 0 1px rgba(43, 189, 155, 0.06),
    0 0 120px rgba(43, 189, 155, 0.07);
  overflow: hidden;
}
.term-bar {
  display: flex;
  align-items: center;
  gap: 18px;
  padding: 20px 26px;
  background: #151918;
  border-bottom: 1px solid #262e2b;
}
.dots {
  display: flex;
  gap: 9px;
}
.dots i {
  width: 15px;
  height: 15px;
  border-radius: 50%;
  display: block;
}
.term-title {
  font-family: v-bind(FONT_MONO);
  font-size: 19px;
  color: #929b95;
}
.term-tier {
  margin-left: auto;
  font-family: v-bind(FONT_MONO);
  font-size: 16px;
  letter-spacing: 0.18em;
  color: #2bbd9b;
  border: 1px solid rgba(43, 189, 155, 0.4);
  padding: 5px 14px;
  border-radius: 6px;
}
.term-body {
  padding: 30px 40px 34px;
  height: 640px;
  font-family: v-bind(FONT_MONO);
  font-size: 21px;
  line-height: 1.62;
}
.row {
  display: flex;
  align-items: baseline;
  white-space: pre-wrap;
}
.mk {
  display: inline-block;
  width: 2.2ch;
  flex-shrink: 0;
  text-align: center;
}
.act :deep(.sfx) {
  opacity: 0.75;
}
.act > span:last-child {
  opacity: 0.62;
}
.cursor {
  display: inline-block;
  width: 12px;
  height: 24px;
  background: #2bbd9b;
  vertical-align: -4px;
  margin-left: 3px;
}
.perm {
  margin: 12px 0 12px 34px;
  padding: 14px 22px;
  border: 1px solid #4a554f;
  border-radius: 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(13, 17, 16, 0.6);
}
.opt {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 1px 8px;
  border-radius: 4px;
}
.ptr {
  width: 1.4ch;
  font-weight: 700;
}
.num {
  opacity: 0.85;
}
.lbl {
  display: inline-block;
  min-width: 17ch;
}
.hint {
  font-size: 18px;
}
.foot {
  font-size: 17px;
  margin-top: 2px;
}
.caption {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 74px;
  text-align: center;
  font-size: 34px;
  color: #edf1e9;
  letter-spacing: 0.04em;
}
</style>
