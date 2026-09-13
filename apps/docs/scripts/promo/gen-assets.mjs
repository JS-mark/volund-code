#!/usr/bin/env node
/* Builds the website-side promo assets (run from apps/docs):
   - .vitepress/theme/assets/promo/audio-{zh,en}.m4a (compressed from .promo-work wavs)
   - .vitepress/theme/assets/promo/volund-promo-{zh,en}-poster.jpg (captured at 16s)
   These live in theme assets (not public/) so PromoPlayer imports them with
   content-hashed URLs — browsers can never serve a stale poster or audio. */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const docsRoot = new URL('../..', import.meta.url).pathname
const workDir = path.join(docsRoot, '.promo-work')
const outDir = path.join(docsRoot, '.vitepress/theme/assets/promo')
fs.mkdirSync(outDir, { recursive: true })

for (const locale of ['zh', 'en']) {
  const wav = path.join(workDir, `audio-${locale}.wav`)
  if (!fs.existsSync(wav)) {
    console.error(`missing ${wav} — run pnpm promo:audio first`)
    process.exit(1)
  }
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    wav,
    '-c:a',
    'aac',
    '-b:a',
    '96k',
    path.join(outDir, `audio-${locale}.m4a`),
  ])
  console.log(`audio-${locale}.m4a`)
}

execSync('node scripts/promo/capture.mjs --poster', { cwd: docsRoot, stdio: 'inherit' })
console.log('posters done')
