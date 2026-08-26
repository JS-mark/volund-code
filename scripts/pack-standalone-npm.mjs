// 把 standalone 产物（apps/cli/dist/standalone/<triple>/）打成 npm 薄壳发布布局：
//
//   <out>/apollo-code/                  meta 包：bin/apollo.cjs 壳 + optionalDependencies
//   <out>/apollo-code-<triple>/         → 发布名 @apollo-code/<triple>（目录名不能用 scope）
//
// 平台包内含完整 standalone 布局（apollo[.exe] + native/ + plugins/ + checksums.sha256），
// 运行时靠 resolver.ts 的 execPath 旁解析惯例自洽。os/cpu/libc 字段让 npm 跳过
// 不匹配的平台包；老版本 npm 忽略 libc 时两个 libc 变体都会安装，壳在运行时按
// glibc 探测自选，行为仍正确（只是多下一份）。
//
// win32-x64-msvc 的 cpu 同时声明 arm64：bun 没有 windows-arm64 编译目标，
// Windows on ARM 经 Prism 仿真跑 x64 包（仿真进程内 process.arch=x64，与包内
// x64 sidecar 自洽）。
//
// 用法：node scripts/pack-standalone-npm.mjs [standaloneDir] [outDir]
import { cp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import { BUN_TARGETS } from './build-standalone.mjs'

const REPOSITORY = 'github.com/JS-mark/apollo-code'

const PLATFORM_FIELDS = {
  'darwin-arm64': { os: ['darwin'], cpu: ['arm64'] },
  'darwin-x64': { os: ['darwin'], cpu: ['x64'] },
  'linux-x64-gnu': { os: ['linux'], cpu: ['x64'], libc: ['glibc'] },
  'linux-arm64-gnu': { os: ['linux'], cpu: ['arm64'], libc: ['glibc'] },
  'linux-x64-musl': { os: ['linux'], cpu: ['x64'], libc: ['musl'] },
  'linux-arm64-musl': { os: ['linux'], cpu: ['arm64'], libc: ['musl'] },
  // Prism 仿真：见文件头注。
  'win32-x64-msvc': { os: ['win32'], cpu: ['x64', 'arm64'] },
}

export async function packStandaloneNpm({ root, standaloneDirectory, outDirectory, version }) {
  const cliManifest = JSON.parse(await readFile(join(root, 'apps/cli/package.json'), 'utf8'))
  const packageVersion = version ?? process.env.APOLLO_BUILD_VERSION ?? cliManifest.version
  if (!packageVersion || packageVersion === '0.0.0')
    throw new Error('apollo-code version is 0.0.0; set APOLLO_BUILD_VERSION or version apps/cli')

  const standalone = standaloneDirectory ?? join(root, 'apps/cli/dist/standalone')
  const triples = (await readdir(standalone, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && BUN_TARGETS[entry.name])
    .map((entry) => entry.name)
    .toSorted((a, b) => a.localeCompare(b))
  if (triples.length === 0)
    throw new Error(`no standalone targets found in ${standalone}; run build-all-standalone first`)

  const out = outDirectory ?? join(root, 'dist/npm')
  const licenseText = await readFile(join(root, 'LICENSE'), 'utf8')
  const readme = await readFile(join(root, 'README.md'), 'utf8')

  for (const triple of triples) {
    const source = join(standalone, triple)
    const exe = triple.startsWith('win32-') ? 'apollo.exe' : 'apollo'
    const dir = join(out, `apollo-code-${triple}`)
    await mkdir(dir, { recursive: true })
    await cp(source, dir, { recursive: true })
    const manifest = {
      name: `@apollo-code/${triple}`,
      version: packageVersion,
      description: `apollo-code standalone binary (${triple})`,
      license: 'Apache-2.0',
      repository: { type: 'git', url: `https://${REPOSITORY}` },
      publishConfig: { access: 'public' },
      files: [exe, 'native', 'plugins', 'checksums.sha256'],
      ...PLATFORM_FIELDS[triple],
    }
    await writeFile(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  }

  const meta = join(out, 'apollo-code')
  await mkdir(join(meta, 'bin'), { recursive: true })
  await cp(join(root, 'apps/cli/bin/apollo.cjs'), join(meta, 'bin/apollo.cjs'))
  await writeFile(join(meta, 'README.md'), readme)
  await writeFile(join(meta, 'LICENSE'), licenseText)
  const optionalDependencies = Object.fromEntries(
    triples.map((triple) => [`@apollo-code/${triple}`, packageVersion]),
  )
  const metaManifest = {
    name: 'apollo-code',
    version: packageVersion,
    description: cliManifest.description ?? 'Open, model-agnostic AI coding CLI',
    license: 'Apache-2.0',
    repository: { type: 'git', url: `https://${REPOSITORY}` },
    publishConfig: { access: 'public' },
    bin: { apollo: 'bin/apollo.cjs' },
    files: ['bin'],
    engines: { node: '>=18' },
    optionalDependencies,
  }
  await writeFile(join(meta, 'package.json'), `${JSON.stringify(metaManifest, null, 2)}\n`)
  console.log(
    `npm staging: apollo-code@${packageVersion} + ${triples.length} platform packages -> ${out}`,
  )
  return { out, triples, version: packageVersion }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, '..')
  await packStandaloneNpm({
    root,
    standaloneDirectory: process.argv[2] ? resolve(process.argv[2]) : undefined,
    outDirectory: process.argv[3] ? resolve(process.argv[3]) : undefined,
  })
}
