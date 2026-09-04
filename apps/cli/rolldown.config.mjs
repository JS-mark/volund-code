// oxlint-disable typescript/consistent-return
import { readFileSync } from 'node:fs'
import { copyFile, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { defineConfig, rolldown } from 'rolldown'

const packageJson = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
const packageVersion = packageJson.version === '0.0.0' ? '0.0.0-dev+local' : packageJson.version
const version = process.env.VOLUND_BUILD_VERSION ?? packageVersion
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
if (!semverPattern.test(version) || version === '0.0.0')
  throw new Error(`VOLUND_BUILD_VERSION must be a non-placeholder SemVer, received: ${version}`)

const identity = {
  version,
  ...(process.env.VOLUND_BUILD_COMMIT ? { commit: process.env.VOLUND_BUILD_COMMIT } : {}),
  ...(process.env.VOLUND_BUILD_CHANNEL ? { channel: process.env.VOLUND_BUILD_CHANNEL } : {}),
  ...(process.env.VOLUND_BUILD_TIME ? { builtAt: process.env.VOLUND_BUILD_TIME } : {}),
}
const identityModuleSuffix = '/src/shared/build-identity.ts'

/**
 * 内置插件产物化：apps/cli/plugins/<name>/{manifest.json,index.mjs} 的源码不进
 * 产物——index.mjs 经嵌套 rolldown 压缩混淆（compress + 顶层 mangle，仅保留对
 * 沙箱装载有意义的 activate 导出名），manifest.json 原样拷贝。standalone 产物
 * 复用这里的 dist/plugins（见 scripts/release/build-standalone.mjs），保证 npm
 * 与 standalone 分发的插件字节一致。dev/vitest 仍直接解析源码目录。
 */
async function buildBuiltinPlugins(pluginsDir, outDir) {
  for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const pluginDir = join(pluginsDir, entry.name)
    const manifest = JSON.parse(await readFile(join(pluginDir, 'manifest.json'), 'utf8'))
    const bundle = await rolldown({ input: join(pluginDir, manifest.main), platform: 'node' })
    try {
      await bundle.write({
        file: join(outDir, entry.name, manifest.main),
        format: 'esm',
        minify: true,
      })
    } finally {
      await bundle.close()
    }
    await copyFile(join(pluginDir, 'manifest.json'), join(outDir, entry.name, 'manifest.json'))
  }
}

export default defineConfig({
  input: 'src/bin.ts',
  output: {
    codeSplitting: false,
    file: 'dist/volund.js',
    format: 'esm',
    // 产物压缩混淆（compress + 顶层 mangle）：npm bin 直跑与 bun --compile
    // 分发同一份字节，源码不随产物外发。
    // ⚠ mangle 必须关：bun build --compile 会对本文件再打包一次，其名字分配器
    // 与 rolldown 已混淆的顶层短名（t7 等）相撞，JSC 里模块级函数解析到错误
    // 绑定，二进制启动即崩（node/bun 直跑同一字节均正常，只有 compile 崩）。
    // mangle:false 保留 compress 的死代码/空格压缩，体积略增换启动正确性。
    minify: { mangle: false },
  },
  platform: 'node',
  plugins: [
    {
      name: 'volund-build-identity',
      load(id) {
        if (id.replaceAll('\\', '/').endsWith(identityModuleSuffix))
          return `export const buildIdentity = ${JSON.stringify(identity)}`
      },
    },
    {
      // 内置插件随产物分发：apps/cli/plugins/<name>/ → dist/plugins/<name>/
      // （运行时由 runtime.ts builtinPluginRoot() 按产物旁解析），JS 压缩混淆后
      // 再落地。目录未随当前提交进仓库时跳过，运行时按"无内置插件"处理。
      name: 'volund-builtin-plugins',
      async writeBundle() {
        try {
          await buildBuiltinPlugins(
            fileURLToPath(new URL('./plugins/', import.meta.url)),
            fileURLToPath(new URL('./dist/plugins/', import.meta.url)),
          )
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      },
    },
  ],
  // 仓库内没有包声明 sideEffects:false，treeshake 只裁剪未使用的导出，
  // 模块顶层副作用全部保留。
  treeshake: false,
})
