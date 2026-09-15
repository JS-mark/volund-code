#!/usr/bin/env node
/* Offline video pipeline for the promo (run from apps/docs):
   node scripts/promo/capture.mjs           → frames + ffmpeg → .promo-work/volund-promo-{zh,en}.mp4
   node scripts/promo/capture.mjs --poster  → public/promo/volund-promo-{zh,en}-poster.jpg
   Builds the docs site, serves .vitepress/dist, and drives the homepage player
   in ?promo-capture mode (window.volundPromoRender) frame by frame. */
import { execFileSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'

import { chromium } from 'playwright-core'

const docsRoot = new URL('../..', import.meta.url).pathname
const workDir = path.join(docsRoot, '.promo-work')
const posterMode = process.argv.includes('--poster')
const BASE = '/volund-code/'

const FPS = 30
const DURATION = 66
const POSTER_FRAME = 480 /* 16s — terminal scene with the approved permission card */
const CHROME = path.join(
  process.env.HOME,
  'Library/Caches/ms-playwright/chromium-1208/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
)

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
  for (const locale of ['zh', 'en']) {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } })
    const home = locale === 'zh' ? `${BASE}zh/` : BASE
    await page.goto(`http://127.0.0.1:${port}${home}?promo-capture`)
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

    const framesDir = path.join(workDir, `frames-${locale}`)
    fs.rmSync(framesDir, { recursive: true, force: true })
    fs.mkdirSync(framesDir, { recursive: true })
    const total = FPS * DURATION
    const started = Date.now()
    for (let f = 0; f < total; f++) {
      await render(page, f / FPS)
      await canvas.screenshot({ path: path.join(framesDir, String(f).padStart(5, '0') + '.png') })
      if (f % 300 === 0)
        console.log(
          locale,
          `frame ${f}/${total} (${(f / ((Date.now() - started) / 1000)).toFixed(1)} fps)`,
        )
    }
    await page.close()

    const wav = path.join(workDir, `audio-${locale}.wav`)
    if (!fs.existsSync(wav)) {
      console.error(`missing ${wav} — run pnpm promo:audio first`)
      process.exit(1)
    }
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-framerate',
        String(FPS),
        '-i',
        path.join(framesDir, '%05d.png'),
        '-i',
        wav,
        '-c:v',
        'libx264',
        '-preset',
        'slow',
        '-crf',
        '18',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
        '-movflags',
        '+faststart',
        path.join(workDir, `volund-promo-${locale}.mp4`),
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] },
    )
    fs.rmSync(framesDir, { recursive: true, force: true })
    console.log('rendered', locale)
  }
} finally {
  await browser.close()
  server.close()
}
