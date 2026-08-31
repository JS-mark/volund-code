#!/usr/bin/env node
import process from 'node:process'

import { runCli } from './cli'
import { createProductionPorts } from './runtime'
import { appIdentity } from './shared/app-identity'
import { createSignalController } from './signals'
const ports = createProductionPorts({ identity: appIdentity })
const signals = createSignalController(ports.session)

let exiting = false
// 信号收尾：interrupt/end 会话后有界关闭长驻资源（插件宿主/MCP），然后硬退。
// 只设 exitCode 不够——残留句柄会顶住事件循环，进程永不退出。
function shutdownAndExit(code: number): void {
  if (exiting) return
  exiting = true
  const budget = new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000)
    timer.unref()
  })
  const teardown = Promise.resolve()
    .then(() => ports.shutdown?.())
    .catch(() => undefined)
  void Promise.race([teardown, budget]).then(() => process.exit(code))
}

process.on('SIGINT', () => {
  void signals.handle('SIGINT').then(shutdownAndExit, () => shutdownAndExit(130))
})
process.on('SIGTERM', () => {
  void signals.handle('SIGTERM').then(shutdownAndExit, () => shutdownAndExit(1))
})
process.on('SIGHUP', () => {
  void signals.handle('SIGHUP').then(shutdownAndExit, () => shutdownAndExit(1))
})
const result = await runCli(process.argv.slice(2), ports)
// 写完再退：管道场景下 process.stdout.write 是异步的，直接 process.exit 会截断输出。
if (result.stdout)
  await new Promise<void>((resolve, reject) =>
    process.stdout.write(result.stdout, (error) => (error ? reject(error) : resolve())),
  )
if (result.stderr)
  await new Promise<void>((resolve, reject) =>
    process.stderr.write(`${result.stderr}\n`, (error) => (error ? reject(error) : resolve())),
  )
process.exit(result.exitCode)
