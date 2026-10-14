#!/usr/bin/env node
/* Offline video pipeline for the promo (run from apps/docs):
   node scripts/promo/capture.mjs                          → frames + ffmpeg → .promo-work/volund-promo-{zh,en}.mp4
   node scripts/promo/capture.mjs --poster                 → public/promo/volund-promo-{zh,en}-poster.jpg
   node scripts/promo/capture.mjs --variant=vertical15     → .promo-work/volund-promo-vertical15-{zh,en}.mp4 (9:16)
   node scripts/promo/capture.mjs --variant=vertical30     → 9:16 30s cut
   node scripts/promo/capture.mjs --variant=wide           → 16:9 cold-open master
   ... add --stills to shoot first/last + per-cut keyframes only (.promo-work/stills/),
   --locale=zh|en to render a single locale (default both).
   Builds the docs site, serves .vitepress/dist, and drives the homepage player
   in ?promo-capture mode (window.volundPromoRender) frame by frame; variants
   add &promo-variant=<id> so the player pins the variant canvas instead.
   Cut lists live in theme/components/promo/variants.json — the audio is
   spliced from the site wav through the same cuts, so picture and sound stay
   frame-aligned. */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { chromium } from 'playwright-core'

const docsRoot = new URL('../..', import.meta.url).pathname
const workDir = path.join(docsRoot, '.promo-work')
const posterMode = process.argv.includes('--poster')
const stillsMode = process.argv.includes('--stills')
const variantArg = process.argv.find((a) => a.startsWith('--variant='))
const variantId = variantArg?.slice('--variant='.length) ?? null
const localeArg = process.argv.find((a) => a.startsWith('--locale='))
const locales = localeArg ? [localeArg.slice('--locale='.length)] : ['zh', 'en']
if (!locales.every((l) => l === 'zh' || l === 'en')) {
  console.error('--locale takes zh or en')
  process.exit(1)
}
const VARIANTS = JSON.parse(
  fs.readFileSync(
    new URL('../../.vitepress/theme/components/promo/variants.json', import.meta.url),
    'utf8',
  ),
)
const variant = variantId ? VARIANTS[variantId] : null
if (variantArg && !variant) {
  console.error(`unknown --variant ${variantId} (known: ${Object.keys(VARIANTS).join(', ')})`)
  process.exit(1)
}
if (posterMode && variant) {
  console.error('--poster captures the site player; use --stills for variant keyframes')
  process.exit(1)
}
if (stillsMode && !variant) {
  console.error('--stills captures variant keyframes; pass --variant=<id>')
  process.exit(1)
}

const FPS = 30
const DURATION = 66
const POSTER_FRAME = 480 /* 16s — terminal scene with the approved permission card */
const BASE = '/volund-code/'

/* Chromium resolution: PROMO_CHROME wins; otherwise the newest chromium-* in
   the playwright cache (app layout differs between builds). */
const resolveChrome = () => {
  if (process.env.PROMO_CHROME) return process.env.PROMO_CHROME
  const cache = path.join(process.env.HOME, 'Library/Caches/ms-playwright')
  const suffixes = [
    'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    'chrome-mac/Chromium.app/Contents/MacOS/Chromium',
  ]
  const dirs = fs
    .readdirSync(cache)
    .filter((d) => d.startsWith('chromium-'))
    .toSorted((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]))
  for (const dir of dirs)
    for (const suffix of suffixes) {
      const exe = path.join(cache, dir, suffix)
      if (fs.existsSync(exe)) return exe
    }
  return null
}
const CHROME = resolveChrome()
if (!CHROME) {
  console.error(
    `no chromium under ${path.join(process.env.HOME, 'Library/Caches/ms-playwright')} — set PROMO_CHROME to a chrome binary`,
  )
  process.exit(1)
}

const variantDuration = (v) => {
  const last = v.cuts[v.cuts.length - 1]
  return last.at + (last.to - last.from)
}

/* Splice the site wav through the variant cut list — the audio edit mirrors
   the picture edit exactly. */
const spliceAudio = (wav, v, out) => {
  const parts = v.cuts.map(
    (c, i) => `[0:a]atrim=start=${c.from}:end=${c.to},asetpts=PTS-STARTPTS[s${i}]`,
  )
  const graph = `${parts.join(';')};${v.cuts
    .map((_, i) => `[s${i}]`)
    .join('')}concat=n=${v.cuts.length}:v=0:a=1[out]`
  execFileSync('ffmpeg', [
    '-y',
    '-v',
    'error',
    '-i',
    wav,
    '-filter_complex',
    graph,
    '-map',
    '[out]',
    out,
  ])
  return out
}

/* --- build the docs site (it hosts the promo components) --- */
execSync('npx vitepress build', { cwd: docsRoot, stdio: 'inherit' })
const distDir = path.join(docsRoot, '.vitepress/dist')

/* --- serve dist/ over http (file:// cannot load ES modules) --- */
const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.woff2': 'font/woff2',
}
const server = http.createServer((req, res) => {
  let p = req.url.split('?')[0]
  if (p.startsWith(BASE)) p = p.slice(BASE.length - 1)
  let file = path.join(distDir, p)
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html')
  if (!fs.existsSync(file)) {
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const port = server.address().port

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--force-color-profile=srgb', '--font-render-hinting=none'],
})

const render = async (page, t) => {
  await page.evaluate((tt) => window.volundPromoRender(tt), t)
  /* let Vue flush + paint */
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  )
}

try {
  for (const locale of locales) {
    const page = await browser.newPage({
      viewport: { width: variant ? variant.w : 1920, height: variant ? variant.h : 1080 },
    })
    const home = locale === 'zh' ? `${BASE}zh/` : BASE
    const query = variant ? `?promo-capture&promo-variant=${variantId}` : '?promo-capture'
    await page.goto(`http://127.0.0.1:${port}${home}${query}`)
    await page.waitForFunction(() => typeof window.volundPromoRender === 'function')
    const canvas = page.locator('.promo-capture')

    if (posterMode) {
      await render(page, POSTER_FRAME / FPS)
      const out = path.join(
        docsRoot,
        '.vitepress/theme/assets/promo',
        `volund-promo-${locale}-poster.jpg`,
      )
      fs.mkdirSync(path.dirname(out), { recursive: true })
      await canvas.screenshot({ path: out, type: 'jpeg', quality: 90 })
      console.log('poster', locale)
      await page.close()
      continue
    }

    const duration = variant ? variantDuration(variant) : DURATION

    if (stillsMode) {
      /* keyframes: first frame, one per cut just after it settles, last frame */
      const stamps = [
        0,
        ...variant.cuts.map((c) => c.at + Math.min(1.2, (c.to - c.from) / 2)),
        duration - 0.1,
      ]
      const outDir = path.join(workDir, 'stills', `${variantId}-${locale}`)
      fs.rmSync(outDir, { recursive: true, force: true })
      fs.mkdirSync(outDir, { recursive: true })
      for (const stamp of new Set(stamps)) {
        await render(page, stamp)
        const name = `${String(Math.round(stamp * FPS)).padStart(5, '0')}.png`
        await canvas.screenshot({ path: path.join(outDir, name) })
      }
      console.log('stills', variantId, locale, '→', path.relative(docsRoot, outDir))
      await page.close()
      continue
    }

    const framesDir = path.join(workDir, `frames-${variantId ?? 'site'}-${locale}`)
    fs.rmSync(framesDir, { recursive: true, force: true })
    fs.mkdirSync(framesDir, { recursive: true })
    const total = Math.ceil(duration * FPS)
    const started = Date.now()
    for (let f = 0; f < total; f++) {
      await render(page, f / FPS)
      await canvas.screenshot({ path: path.join(framesDir, String(f).padStart(5, '0') + '.png') })
      if (f % 300 === 0)
        console.log(
          variantId ?? 'site',
          locale,
          `frame ${f}/${total} (${(f / ((Date.now() - started) / 1000)).toFixed(1)} fps)`,
        )
    }
    await page.close()

    const wav = path.join(workDir, `audio-${locale}.wav`)
    let audioFile = null
    if (variant) {
      /* variants tolerate a missing wav — they render silent with a warning */
      if (fs.existsSync(wav))
        audioFile = spliceAudio(
          wav,
          variant,
          path.join(workDir, `audio-${variantId}-${locale}.wav`),
        )
      else console.warn(`missing ${wav} — rendering ${variantId} ${locale} silent`)
    } else if (!fs.existsSync(wav)) {
      console.error(`missing ${wav} — run pnpm promo:audio first`)
      process.exit(1)
    } else audioFile = wav

    const mp4 = path.join(workDir, `volund-promo-${variantId ? `${variantId}-` : ''}${locale}.mp4`)
    const args = ['-y', '-framerate', String(FPS), '-i', path.join(framesDir, '%05d.png')]
    if (audioFile) args.push('-i', audioFile)
    args.push('-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p')
    if (audioFile) args.push('-c:a', 'aac', '-b:a', '192k')
    args.push('-shortest', '-movflags', '+faststart', mp4)
    execFileSync('ffmpeg', args, { stdio: ['ignore', 'ignore', 'inherit'] })
    fs.rmSync(framesDir, { recursive: true, force: true })
    console.log('rendered', variantId ?? 'site', locale)
  }
} finally {
  await browser.close()
  server.close()
}
