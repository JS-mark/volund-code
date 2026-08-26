#!/usr/bin/env node
// apollo-code 的 npm 薄壳：真正的可执行文件是按平台分发的 bun 单文件二进制，
// 装在 optionalDependencies 的 @apollo-code/<triple> 平台包里。本壳只负责
// 解析宿主平台对应的包并把调用转发过去（stdio 直通、退出码/信号透传）。
//
// Windows arm64 说明：bun --compile 不支持 bun-windows-arm64，该平台装
// @apollo-code/win32-x64-msvc（cpu 字段含 arm64），经 Prism 仿真运行；
// 仿真进程内 process.arch 为 x64，与包内 x64 sidecar 自洽。
'use strict'

const { spawnSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'win32') return 'win32-x64-msvc' // arm64 走 x64 仿真包，见文件头注释
  if (process.platform === 'linux') {
    const report = process.report && process.report.getReport ? process.report.getReport() : null
    const header = report && typeof report.header === 'object' ? report.header : null
    const libc = header && 'glibcVersionRuntime' in header ? 'gnu' : 'musl'
    return `linux-${arch}-${libc}`
  }
  return null
}

function fail(message) {
  process.stderr.write(`apollo: ${message}\n`)
  process.exit(1)
}

const triple = hostTriple()
if (!triple)
  fail(
    `unsupported platform ${process.platform}/${process.arch}; see https://github.com/JS-mark/apollo-code/releases for manual downloads`,
  )

// 本文件在 meta 包的 bin/ 下，require.resolve 从这里向 node_modules 上游解析，
// 正好命中以 optionalDependencies 形式安装在旁边的平台包。
let packageDir
try {
  packageDir = path.dirname(require.resolve(`@apollo-code/${triple}/package.json`))
} catch {
  fail(
    `platform package @apollo-code/${triple} is not installed (optional dependency skipped?). ` +
      `Reinstall with optional dependencies enabled, or download the standalone archive from https://github.com/JS-mark/apollo-code/releases`,
  )
}

const executable = path.join(packageDir, triple.startsWith('win32-') ? 'apollo.exe' : 'apollo')
try {
  fs.accessSync(executable, fs.constants.X_OK)
} catch {
  // npm 解包通常保留 tar 里的可执行位；个别文件系统丢失时兜底补一次。
  try {
    fs.chmodSync(executable, 0o755)
  } catch {
    fail(`platform binary missing at ${executable}`)
  }
}

const result = spawnSync(executable, process.argv.slice(2), {
  stdio: 'inherit',
  // Windows 上 .exe 直接可执行；显式关闭 shell 避免参数被二次解释。
  shell: false,
})
if (result.error) fail(`failed to launch ${executable}: ${result.error.message}`)
if (result.signal) {
  // 让父进程以同一信号死亡，脚本里 $?=128+sig 的惯例才成立。
  process.kill(process.pid, result.signal)
  process.exit(128 + (require('node:os').constants.signals[result.signal] ?? 0))
}
process.exit(result.status ?? 1)
