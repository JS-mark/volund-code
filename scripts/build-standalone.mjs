import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

// 与 native.yml 的 8 个 target、resolver.ts packageTriple 的输出一一对应。
const VALID_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-x64-gnu',
  'linux-arm64-gnu',
  'linux-x64-musl',
  'linux-arm64-musl',
  'win32-x64-msvc',
  'win32-arm64-msvc',
]

// bun --compile 的跨平台目标名。win32-arm64-msvc 不在列：bun 没有
// bun-windows-arm64 目标，Windows arm64 由 x64 包经 Prism 仿真覆盖（见
// apps/cli/bin/volund.cjs 头注），因此 standalone 实际产出 7 个 target。
export const BUN_TARGETS = {
  'darwin-arm64': 'bun-darwin-arm64',
  'darwin-x64': 'bun-darwin-x64',
  'linux-x64-gnu': 'bun-linux-x64',
  'linux-arm64-gnu': 'bun-linux-arm64',
  'linux-x64-musl': 'bun-linux-x64-musl',
  'linux-arm64-musl': 'bun-linux-arm64-musl',
  'win32-x64-msvc': 'bun-windows-x64',
}

export function targetTripleFor(platform, arch, libc) {
  const normalizedArch = arch === 'arm64' || arch === 'x64' ? arch : null
  if (!normalizedArch) return null
  if (platform === 'darwin') return `darwin-${normalizedArch}`
  if (platform === 'win32') return `win32-${normalizedArch}-msvc`
  if (platform === 'linux') return `linux-${normalizedArch}-${libc === 'musl' ? 'musl' : 'gnu'}`
  return null
}

function hostTarget() {
  const report = process.report?.getReport?.()
  const header = report && typeof report.header === 'object' ? report.header : null
  const libc =
    process.platform !== 'linux'
      ? undefined
      : header && 'glibcVersionRuntime' in header
        ? 'glibc'
        : 'musl'
  return targetTripleFor(process.platform, process.arch, libc)
}

export async function createNativeManifest(assetDirectory, outputDirectory, target) {
  const assets = []
  await mkdir(outputDirectory, { recursive: true })
  const suffix = target.startsWith('win32-') ? '.exe' : ''
  for (const kind of ['sandbox', 'search', 'fs']) {
    const file = `volund-${kind}-${target}${suffix}`
    let source = join(assetDirectory, file)
    try {
      await access(source)
    } catch {
      // 本地 cargo 布局兜底：target/release/volund-<kind>[.exe] 按目标名收编。
      source = join(assetDirectory, `volund-${kind}${suffix}`)
      try {
        await access(source)
      } catch {
        throw new Error(
          `missing native asset for ${kind}: expected ${file} or volund-${kind}${suffix} in ${assetDirectory}`,
        )
      }
    }
    const body = await readFile(source)
    await copyFile(source, join(outputDirectory, file))
    assets.push({ kind, target, file, sha256: createHash('sha256').update(body).digest('hex') })
  }
  const manifest = { schemaVersion: 1, assets }
  await writeFile(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return manifest
}

/**
 * 组装一个 target 的 standalone 目录：<out>/{volund[.exe], native/, plugins/, checksums.sha256}。
 * bun --compile 恒带 --target：使用官方分发的 bun 运行时，产物与构建宿主解耦、可复现，
 * 代价是首次每个 target 要下载对应的 bun 二进制（之后走 bun 自身缓存）。
 */
export async function buildStandalone({ root, target, assetDirectory, outDirectory }) {
  if (!VALID_TARGETS.includes(target))
    throw new Error(`invalid target '${target}'; expected one of: ${VALID_TARGETS.join(', ')}`)
  const bunTarget = BUN_TARGETS[target]
  if (!bunTarget)
    throw new Error(
      `target '${target}' has no bun compile target (bun-windows-arm64 does not exist); ` +
        'Windows arm64 is served by the win32-x64-msvc build under Prism emulation',
    )
  const bundle = join(root, 'apps/cli/dist/volund.js')
  try {
    await access(bundle)
  } catch {
    throw new Error('apps/cli/dist/volund.js not found; run `pnpm --filter volund-cli build` first')
  }
  const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' })
  if (bun.status !== 0)
    throw new Error('bun is required for standalone builds; pkg is rejected by the RFC')

  const out = outDirectory ?? join(root, 'apps/cli/dist/standalone', target)
  await createNativeManifest(resolve(assetDirectory), join(out, 'native'), target)
  // 内置插件（apps/cli/plugins/<name>/）随 standalone 产物分发到 <out>/plugins/，
  // 运行时解析惯例与 native/ 一致（VOLUND_STANDALONE_ASSET_DIR 或产物旁）。
  // 目录不存在（未随当前提交进仓库）时跳过，运行时按"无内置插件"处理。
  try {
    await cp(resolve(root, 'apps/cli/plugins'), join(out, 'plugins'), { recursive: true })
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  const executable = join(out, `volund${target.startsWith('win32-') ? '.exe' : ''}`)
  const result = spawnSync(
    'bun',
    ['build', '--compile', '--target', bunTarget, bundle, '--outfile', executable],
    { stdio: 'inherit' },
  )
  if (result.status !== 0) throw new Error(`bun compile failed with status ${result.status}`)
  const digest = createHash('sha256')
    .update(await readFile(executable))
    .digest('hex')
  await writeFile(join(out, 'checksums.sha256'), `${digest}  ${basename(executable)}\n`)
  return { out, executable }
}

async function main() {
  const root = resolve(import.meta.dirname, '..')
  const target = process.env.VOLUND_STANDALONE_TARGET ?? hostTarget()
  if (!target)
    throw new Error(
      `unsupported host platform; set VOLUND_STANDALONE_TARGET explicitly (one of: ${VALID_TARGETS.join(', ')})`,
    )

  let assetDirectory = process.env.VOLUND_NATIVE_ASSET_DIR
  if (!assetDirectory) {
    // 本地默认：直接吃 cargo 产物。先重编保证与 crates/ 源码一致，避免过期二进制被静默打包。
    const cargo = spawnSync('cargo', ['build', '--release'], { cwd: root, stdio: 'inherit' })
    if (cargo.error ?? cargo.status !== 0)
      throw new Error(
        'cargo build --release failed; install the Rust toolchain or set VOLUND_NATIVE_ASSET_DIR to a directory of prebuilt volund-<kind>-<target> binaries',
      )
    assetDirectory = join(root, 'target', 'release')
  }

  const out = resolve(
    process.env.VOLUND_STANDALONE_OUT ?? join(root, 'apps/cli/dist/standalone', target),
  )
  console.log(`standalone: target=${target} assets=${assetDirectory} out=${out}`)
  await buildStandalone({ root, target, assetDirectory, outDirectory: out })
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) await main()
