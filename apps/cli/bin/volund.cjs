#!/usr/bin/env node
// Volund CLI npm wrapper. The actual runtime is supplied by the host-specific
// optional dependency. This process forwards stdio, arguments, exit status,
// and termination signals without invoking a shell.
'use strict'

const { spawn } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function hostTriple() {
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'x64' ? 'x64' : null
  if (!arch) return null
  if (process.platform === 'darwin') return `darwin-${arch}`
  // Bun does not provide a Windows arm64 compile target. Windows arm64 installs
  // and runs the x64 package through Prism; inside that emulated process arch=x64.
  if (process.platform === 'win32') return 'win32-x64-msvc'
  if (process.platform === 'linux') {
    const report = process.report && process.report.getReport ? process.report.getReport() : null
    const header = report && typeof report.header === 'object' ? report.header : null
    const libc = header && 'glibcVersionRuntime' in header ? 'gnu' : 'musl'
    return `linux-${arch}-${libc}`
  }
  return null
}

function fail(message) {
  process.stderr.write(`volund: ${message}\n`)
  process.exit(1)
}

const triple = hostTriple()
if (!triple)
  fail(
    `unsupported platform ${process.platform}/${process.arch}; see https://github.com/JS-mark/volund-code/releases for manual downloads`,
  )

let packageDir
try {
  packageDir = path.dirname(require.resolve(`@volund/${triple}/package.json`))
} catch {
  fail(
    `platform package @volund/${triple} is not installed (optional dependency skipped?). ` +
      `Reinstall without --omit=optional (and with optional dependencies enabled), or download the standalone archive from https://github.com/JS-mark/volund-code/releases`,
  )
}

const executable = path.join(packageDir, triple.startsWith('win32-') ? 'volund.exe' : 'volund')
try {
  fs.accessSync(executable, fs.constants.X_OK)
} catch {
  try {
    fs.chmodSync(executable, 0o755)
  } catch {
    fail(`platform binary missing at ${executable}`)
  }
}

const child = spawn(executable, process.argv.slice(2), {
  stdio: 'inherit',
  shell: false,
})

const signalHandlers = new Map()
let forwardedSignal = null
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  const handler = () => {
    if (!forwardedSignal) forwardedSignal = signal
    if (child.exitCode === null && child.signalCode === null) child.kill(signal)
  }
  try {
    process.on(signal, handler)
    signalHandlers.set(signal, handler)
  } catch {
    // Some Windows Node builds do not expose every POSIX signal.
  }
}

function removeSignalHandlers() {
  for (const [signal, handler] of signalHandlers) process.removeListener(signal, handler)
}

child.once('error', (error) => {
  removeSignalHandlers()
  fail(`failed to launch ${executable}: ${error.message}`)
})

child.once('exit', (code, signal) => {
  removeSignalHandlers()
  const terminationSignal = forwardedSignal || signal
  if (terminationSignal) {
    process.kill(process.pid, terminationSignal)
    return
  }
  process.exitCode = code ?? 1
})
