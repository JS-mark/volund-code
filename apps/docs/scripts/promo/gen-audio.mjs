#!/usr/bin/env node
/* Generates .promo-work/audio-{zh,en}.wav — ambient pad + bass pulse + arpeggio,
   with keystroke ticks aligned to the typing plan and chimes on approvals. */
import fs from 'node:fs'

const SR = 44100
const DUR = 66
const N = SR * DUR

const NOTE = {
  A1: 55, F1: 43.65, C2: 65.41, G1: 49,
  A2: 110, C3: 130.81, E3: 164.81, F2: 87.31, G2: 98, B2: 123.47, D3: 146.83,
  A3: 220, C4: 261.63, E4: 329.63, F3: 174.61, G3b: 196, B3: 246.94, D4: 293.66,
  A4: 440, C5: 523.25, E5: 659.25, A5: 880,
  F4: 349.23, G4: 392,
}

const CHORDS = [
  { root: 'A1', pad: ['A2', 'C3', 'E3', 'A3'], arp: ['A3', 'C4', 'E4', 'A4'] },
  { root: 'F1', pad: ['F2', 'A2', 'C3', 'F3'], arp: ['F3', 'A3', 'C4', 'F4'] },
  { root: 'C2', pad: ['C3', 'E3', 'G3b', 'C4'], arp: ['C4', 'E4', 'G4', 'C5'] },
  { root: 'G1', pad: ['G2', 'B2', 'D3', 'G3b'], arp: ['G3b', 'B3', 'D4', 'G4'] },
]

const INSTALL = { text: 'npm install --global @volund/cli', start: 59.9, cps: 22 }

function makeTrack(L, R, locale) {
  const addSine = (t0, t1, freq, gain, pan = 0.5, attack = 0.02, release = 0.08, vibDepth = 0, vibRate = 5) => {
    const i0 = Math.max(0, Math.floor(t0 * SR))
    const i1 = Math.min(N, Math.floor(t1 * SR))
    const gL = Math.cos((pan * Math.PI) / 2) * gain
    const gR = Math.sin((pan * Math.PI) / 2) * gain
    for (let i = i0; i < i1; i++) {
      const t = i / SR - t0
      const dur = t1 - t0
      let env = Math.min(1, t / attack) * Math.min(1, (dur - t) / release)
      env = Math.max(0, env)
      const f = freq * (1 + vibDepth * Math.sin(2 * Math.PI * vibRate * t))
      const s = Math.sin(2 * Math.PI * f * t)
      L[i] += s * env * gL
      R[i] += s * env * gR
    }
  }
  const addNoiseBurst = (t0, dur, gain, lp = 0.15) => {
    const i0 = Math.floor(t0 * SR)
    const i1 = Math.min(N, Math.floor((t0 + dur) * SR))
    let prev = 0
    for (let i = i0; i < i1; i++) {
      const t = i / SR - t0
      const env = Math.sin(Math.PI * Math.min(1, t / dur)) ** 2
      const white = Math.random() * 2 - 1
      prev = prev + lp * (white - prev)
      L[i] += prev * env * gain
      R[i] += prev * env * gain
    }
  }
  const addTick = (t0, gain = 0.05) => {
    const dur = 0.018
    const i0 = Math.floor(t0 * SR)
    const i1 = Math.min(N, Math.floor((t0 + dur) * SR))
    for (let i = i0; i < i1; i++) {
      const t = i / SR - t0
      const env = Math.exp(-t * 260)
      const s = (Math.random() * 2 - 1) * 0.6 + Math.sin(2 * Math.PI * 1900 * t) * 0.4
      L[i] += s * env * gain
      R[i] += s * env * gain
    }
  }

  const SEG = 8.25
  const beat = 60 / 82
  for (let c = 0; c < 8; c++) {
    const t0 = c * SEG
    const ch = CHORDS[c % 4]
    for (const n of ch.pad) {
      const f = NOTE[n]
      addSine(t0 - 0.05, t0 + SEG + 0.4, f * 1.002, 0.028, 0.35, 1.8, 1.8, 0.0015, 4.7)
      addSine(t0 - 0.05, t0 + SEG + 0.4, f * 0.998, 0.028, 0.65, 2.1, 1.6, 0.0015, 5.3)
    }
    for (let b = 0; b < SEG / beat; b++) {
      const bt = t0 + b * beat
      addSine(bt, bt + beat * 0.9, NOTE[ch.root], 0.055, 0.5, 0.01, 0.18)
    }
    for (let s = 0; s < SEG / (beat / 4); s++) {
      const at = t0 + s * (beat / 4)
      if (at < 11 || at > 58) continue
      const g = 0.028 * Math.min(Math.min(1, (at - 11) / 3), Math.min(1, (58 - at) / 3))
      if (g <= 0) continue
      const seq = [0, 2, 1, 3, 2, 0, 3, 1]
      addSine(at, at + (beat / 4) * 0.95, NOTE[ch.arp[seq[s % seq.length]]], g, 0.3 + 0.4 * ((s % 4) / 3), 0.005, 0.09)
    }
  }

  /* keystroke ticks from the shared typing plan */
  const planPath = new URL('../../.vitepress/theme/components/promo/typing-plan.json', import.meta.url)
  const p = JSON.parse(fs.readFileSync(planPath))[locale]
  for (let i = 0; i < p.cmd1.length; i++) addTick(p.cmd1Start + i / p.cmd1Cps, 0.035)
  for (let i = 0; i < p.cmd2.length; i++) addTick(p.cmd2Start + i / p.cmd2Cps, 0.03)
  for (let i = 0; i < INSTALL.text.length; i++) addTick(INSTALL.start + i / INSTALL.cps, 0.032)

  /* approval + test chimes */
  addSine(15.2, 15.9, NOTE.E5, 0.05, 0.5, 0.005, 0.5)
  addSine(15.32, 16.2, NOTE.A5, 0.045, 0.5, 0.005, 0.6)
  addSine(17.2, 17.9, NOTE.A5, 0.05, 0.5, 0.005, 0.5)
  addSine(17.38, 18.3, NOTE.C5 * 2, 0.04, 0.5, 0.005, 0.6)

  /* transitions + opening shimmer */
  for (const t of [4.8, 26.8, 35.8, 47.8, 57.8]) addNoiseBurst(t, 0.6, 0.05, 0.12)
  addNoiseBurst(0.2, 1.6, 0.03, 0.06)
}

function writeWav(path, L, R) {
  for (let i = 0; i < N; i++) {
    const t = i / SR
    const fade = Math.min(1, t / 0.6) * Math.min(1, (DUR - t) / 1.8)
    L[i] = Math.tanh(L[i] * 1.4) * 0.85 * fade
    R[i] = Math.tanh(R[i] * 1.4) * 0.85 * fade
  }
  const buf = Buffer.alloc(44 + N * 4)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 4, 28)
  buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(N * 4, 40)
  for (let i = 0; i < N; i++) {
    buf.writeInt16LE((Math.max(-1, Math.min(1, L[i])) * 32767) | 0, 44 + i * 4)
    buf.writeInt16LE((Math.max(-1, Math.min(1, R[i])) * 32767) | 0, 44 + i * 4 + 2)
  }
  fs.writeFileSync(path, buf)
  console.log(path, (buf.length / 1e6).toFixed(1), 'MB')
}

const outDir = new URL('../../.promo-work/', import.meta.url).pathname
fs.mkdirSync(outDir, { recursive: true })
for (const locale of ['zh', 'en']) {
  const L = new Float32Array(N)
  const R = new Float32Array(N)
  makeTrack(L, R, locale)
  writeWav(`${outDir}audio-${locale}.wav`, L, R)
}
