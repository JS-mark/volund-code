import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { pinPluginPublisher, readPluginTrustStore, upgradePlugins } from '@volund/app-runtime'
import { ErrorCodes, productIdentity, sanitize, validateWorkspacePath } from '@volund/shared'
import {
  PermissionPromptController,
  renderSecurityBanner,
  statusPanelFromWelcome,
} from '@volund/ui'
import type {
  DangerousMode,
  NativeModuleStatus,
  SandboxDisclosure,
  StatusPanelData,
  WelcomeModelStatus,
  WelcomeNativeStatus,
  WelcomePanelData,
  WelcomeSandboxStatus,
} from '@volund/ui'
import { parseArgs } from 'citty'

import { CommandRegistry } from './app/command-registry'
import { createCommand, renderGlobalUsage } from './command'
import { createConfigCommand } from './commands/config'
import { doctorCommand } from './commands/doctor'
import { actionStyleCommands, commandUsage } from './commands/help'
import { createHistoryCommand } from './commands/history'
import { createMemoryCommand } from './commands/memory'
import { createRemoteCommand } from './commands/remote'
import { createSessionsCommand } from './commands/sessions'
import { createStatusCommand } from './commands/status'
import { daemonCommand, tasksCommand, volundHome } from './commands/tasks'
import { telemetryCommand } from './commands/telemetry'
import { trustCommand } from './commands/trust'
import { readDaemonStatus, spawnDetachedDaemon } from './daemon'
import { createMemoryPanelController } from './memory-panel'
import { projectMemoryScope } from './memory-scope'
import {
  buildPlugin,
  cratePlugin,
  devPlugin,
  devReloadLine,
  installGithubSpec,
  installVolundArchive,
  watchPluginDev,
} from './plugin-authoring'
import type { VolundPorts } from './ports'
import type { CliIo, CliResult, ParsedCliArgs } from './shared/cli-types'

const defaultInteractiveModel = 'anthropic/claude-sonnet-4-20250514'
const registeredPluginErrorCodes: ReadonlySet<string> = new Set(
  Object.values(ErrorCodes).filter((code) => code.startsWith('plugin_')),
)

const argsDefinition = {
  cwd: { type: 'string' as const },
  json: { type: 'boolean' as const },
  noColor: { type: 'boolean' as const },
  noTui: { type: 'boolean' as const },
  strict: { type: 'boolean' as const },
  strictSandbox: { type: 'boolean' as const },
  dangerousNoSandbox: { type: 'boolean' as const },
  dangerouslySkipPermissions: { type: 'boolean' as const },
  yolo: { type: 'boolean' as const },
  permissionMode: { type: 'string' as const },
  apiKeyStdin: { type: 'boolean' as const },
  skipVerify: { type: 'boolean' as const },
  dangerous: { type: 'boolean' as const },
  dryRun: { type: 'boolean' as const },
  all: { type: 'boolean' as const },
  trustWorkspace: { type: 'boolean' as const },
  namespace: { type: 'string' as const },
  since: { type: 'string' as const },
  to: { type: 'string' as const },
  scope: { type: 'string' as const },
  sessionId: { type: 'string' as const },
  tag: { type: 'string' as const },
  limit: { type: 'string' as const },
  batchSize: { type: 'string' as const },
  check: { type: 'boolean' as const },
  force: { type: 'boolean' as const },
  project: { type: 'boolean' as const },
  olderThan: { type: 'string' as const },
  output: { type: 'string' as const },
  o: { type: 'string' as const },
  source: { type: 'string' as const },
  pinned: { type: 'boolean' as const },
  cursor: { type: 'string' as const },
  enable: { type: 'string' as const },
  disable: { type: 'string' as const },
  // [tasks] 命令族（W-17）：citty 只认声明的 flag——未声明 --name 会被拆成
  // boolean + 游离位置参数，所以任务 flag 全部在此登记（全局 flag 池惯例）。
  name: { type: 'string' as const },
  prompt: { type: 'string' as const },
  schedule: { type: 'string' as const },
  tz: { type: 'string' as const },
  missed: { type: 'string' as const },
  overlap: { type: 'string' as const },
  model: { type: 'string' as const },
  budget: { type: 'string' as const },
  allowedTools: { type: 'string' as const },
  timeoutMs: { type: 'string' as const },
  maxRetries: { type: 'string' as const },
  disabled: { type: 'boolean' as const },
  id: { type: 'string' as const },
  content: { type: 'string' as const },
  bodyStdin: { type: 'boolean' as const },
  expectedUpdatedAt: { type: 'string' as const },
  strategy: { type: 'string' as const },
  maxAge: { type: 'string' as const },
  yes: { type: 'boolean' as const },
  gateway: { type: 'string' as const },
  code: { type: 'string' as const },
}
export type { CliIo, CliResult } from './shared/cli-types'
const defaultIo: CliIo = {
  isInteractiveTerminal() {
    return Boolean(process.stdin.isTTY && process.stdout.isTTY)
  },
  async readStdin() {
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks).toString('utf8')
  },
  async confirm(message) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout })
    try {
      return (await prompt.question(`${message} [y/N] `)).trim().toLowerCase() === 'y'
    } finally {
      prompt.close()
    }
  },
}
export async function runCli(
  rawArgs: string[],
  ports: VolundPorts,
  io: CliIo = defaultIo,
): Promise<CliResult> {
  const command = createCommand(ports.identity)
  // Per-command help (spec §11.3 `volund help [command]`). Help must short-circuit
  // before sandbox probing, trust checks, or session startup. Tokens after `--`
  // belong to a subprocess (mcp add passthrough), so help flags are only scanned
  // before it; a bare `help` positional only counts for action-style commands,
  // where it would otherwise just error as an unknown action.
  const passthrough = rawArgs.indexOf('--')
  const scannable = passthrough === -1 ? rawArgs : rawArgs.slice(0, passthrough)
  const wantsHelp = scannable.includes('--help') || scannable.includes('-h')
  if (rawArgs[0] === 'help') {
    const topic = rawArgs[1]
    if (topic === undefined || topic.startsWith('-'))
      return { exitCode: 0, stdout: await renderGlobalUsage(command), stderr: '' }
    const usage = commandUsage[topic]
    return usage === undefined
      ? {
          exitCode: 2,
          stdout: '',
          stderr: `Unknown command: ${topic}. Run '${productIdentity.commandName} help' to list commands.`,
        }
      : { exitCode: 0, stdout: usage, stderr: '' }
  }
  const topicUsage = rawArgs[0] === undefined ? undefined : commandUsage[rawArgs[0]]
  if (
    topicUsage !== undefined &&
    (wantsHelp || (rawArgs[1] === 'help' && actionStyleCommands.has(rawArgs[0]!)))
  )
    return { exitCode: 0, stdout: topicUsage, stderr: '' }
  if (wantsHelp) return { exitCode: 0, stdout: await renderGlobalUsage(command), stderr: '' }
  // -v/--version 只在首个位置参数之前生效：`volund tasks list -v` 这类子命令
  // 尾部的版本旗标不再抢跑成版本输出（此前任何位置的 -v 都会短路整个派发）。
  // 首个位置参数用与 firstUnsupportedGlobalFlag 同口径的扫描（value flag 的值
  // 不算位置参数），否则 `volund --cwd /x -v` 会得出两个互相矛盾的「第一个位置」。
  const firstPositionalIndex = firstNonFlagTokenIndex(scannable)
  const versionFlagIndex = scannable.findIndex((token) => token === '--version' || token === '-v')
  if (
    rawArgs[0] === 'version' ||
    (versionFlagIndex !== -1 &&
      (firstPositionalIndex === -1 || versionFlagIndex < firstPositionalIndex))
  )
    return { exitCode: 0, stdout: `${ports.identity.version}\n`, stderr: '' }
  const args = parseArgs(rawArgs, argsDefinition) as ParsedCliArgs
  // citty 把 --no-<flag> 归一成 <flag>:false（--no-tui → tui:false），下游直接读
  // args.noTui 永远 undefined——归一回布尔口径，memory/history/sessions 的
  // 「非交互必须 --yes」确认契约才能真正吃到它。
  if ((args as { tui?: boolean }).tui === false) args.noTui = true
  // `--` 之后的 token 属于子进程（mcp add 透传），不参与子命令派发：
  // `volund -- help` 是把 "help" 交给会话，不是查帮助。
  const firstPositional = firstPositionalIndex === -1 ? undefined : scannable[firstPositionalIndex]
  // Only these names dispatch as subcommands; any other first positional is
  // the prompt of the default session (`volund "summarize this repo"`).
  const subcommand =
    firstPositional !== undefined && reservedCommandNames.has(firstPositional)
      ? firstPositional
      : undefined
  let stdout = ''
  let stderr = ''
  const jsonMode = Boolean(args.json)
  const noColor = Boolean(args.noColor) || (args as { color?: boolean }).color === false
  const noTui = Boolean(args.noTui) || (args as { tui?: boolean }).tui === false
  // W-17 F1-02：任务约束旗标 → 会话启动 overrides（仅新会话；resume 不吃）。
  // fail-fast：--budget 形状错误在信任门之前就报 usage 错。
  let taskBudget: { costUSDMax?: number; tokenMax?: number; timeMsMax?: number } | undefined
  if (typeof args.budget === 'string' && args.budget) {
    try {
      const parsed = JSON.parse(args.budget) as Record<string, unknown>
      taskBudget = {
        ...(typeof parsed.costUSDMax === 'number' ? { costUSDMax: parsed.costUSDMax } : {}),
        ...(typeof parsed.tokenMax === 'number' ? { tokenMax: parsed.tokenMax } : {}),
        ...(typeof parsed.timeMsMax === 'number' ? { timeMsMax: parsed.timeMsMax } : {}),
      }
    } catch {
      return jsonMode
        ? jsonFailure('--budget must be a JSON object', 2, 'usage')
        : {
            exitCode: 2,
            stdout,
            stderr: '--budget must be a JSON object like {"timeMsMax":600000}',
          }
    }
  }
  const taskTools =
    typeof args.allowedTools === 'string' && args.allowedTools
      ? args.allowedTools
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : undefined
  // §4.4 fail-fast：--permission-mode 形状错误与 --budget 同期报 usage 错——
  // 未信任目录下不该先吃 directory_untrusted 再轮到用法错。
  const flagMode =
    args.permissionMode === 'ask' ||
    args.permissionMode === 'auto' ||
    args.permissionMode === 'full'
      ? args.permissionMode
      : undefined
  if (args.permissionMode !== undefined && flagMode === undefined) {
    const message = `invalid --permission-mode '${String(args.permissionMode)}' (ask | auto | full)`
    return jsonMode ? jsonFailure(message, 2, 'usage') : { exitCode: 2, stdout, stderr: message }
  }
  // W-17：daemon spawn 时注入 VOLUND_TASK_RUN → 本会话流发射 task.* 生命周期
  // 事件。读后即删：防 Bash 工具再 spawn 的 volund 误认自己是任务运行。
  let taskRun: { taskId: string; runId: string; scheduledFor: number } | undefined
  if (process.env.VOLUND_TASK_RUN) {
    try {
      const parsed = JSON.parse(process.env.VOLUND_TASK_RUN) as Record<string, unknown>
      if (
        typeof parsed.taskId === 'string' &&
        typeof parsed.runId === 'string' &&
        typeof parsed.scheduledFor === 'number'
      )
        taskRun = { taskId: parsed.taskId, runId: parsed.runId, scheduledFor: parsed.scheduledFor }
    } catch {
      // 非法形状按缺省处理（无害：只是不发 task.* 事件）。
    }
    delete process.env.VOLUND_TASK_RUN
  }
  let resumeSelection: { id: string; cwd: string } | undefined
  // 未知全局旗标检查：无子命令时扫全量；有子命令时只扫它之前的「全局区」——
  // 子命令自己的旗标（--name/--id/…）不归本检查管，但 `volund --foo status`
  // 这种全局区里的未知旗标不再静默忽略。
  const unsupportedGlobalFlag = firstUnsupportedGlobalFlag(
    subcommand !== undefined && firstPositionalIndex !== -1
      ? rawArgs.slice(0, firstPositionalIndex)
      : rawArgs,
  )
  if (unsupportedGlobalFlag) {
    const message =
      subcommand === undefined
        ? `Unsupported global flag without a command: ${unsupportedGlobalFlag}`
        : `Unsupported global flag before '${subcommand}': ${unsupportedGlobalFlag}`
    return jsonMode
      ? jsonFailure(message, 2, 'unsupported_flag', 'usage')
      : { exitCode: 2, stdout, stderr: message }
  }
  // 子命令自己的旗标区（上面的全局区检查不覆盖）：未知旗标 fail-fast——citty
  // 会把未声明 --flag 的值拆成游离位置参数（`memory add --title x` 的值静默
  // 拼进正文）。chatGlobalFlags 成员归上面的 chat 越权检查管，这里跳过。
  if (subcommand !== undefined && firstPositionalIndex !== -1) {
    for (const token of rawArgs.slice(firstPositionalIndex)) {
      if (token === '--' || chatGlobalFlags.has(token)) break
      const flag = normalizeFlagToken(token)
      if (flag === undefined || chatGlobalFlags.has(`--${token.slice(2)}`)) continue
      if (
        !declaredFlags.has(flag) &&
        !declaredFlags.has(`no${flag[0]?.toUpperCase()}${flag.slice(1)}`)
      )
        return jsonMode
          ? jsonFailure(`unknown option: ${token.split('=', 1)[0]}`, 2, 'unknown_flag', 'usage')
          : {
              exitCode: 2,
              stdout: '',
              stderr: `unknown option: ${token.split('=', 1)[0]}\n(run 'volund help ${subcommand}' for usage)\n`,
            }
    }
  }
  let cwd: string
  try {
    cwd = await validateWorkspacePath(String(args.cwd ?? process.cwd()))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonMode
      ? jsonFailure(message, 1, 'invalid_workspace')
      : { exitCode: 1, stdout, stderr: message }
  }
  const registry = new CommandRegistry([
    doctorCommand,
    telemetryCommand,
    trustCommand,
    createConfigCommand(io),
    createHistoryCommand(io),
    createSessionsCommand(io),
    createStatusCommand({
      buildFallback: async (fallbackCwd) =>
        buildWelcomePanelData({
          cwd: fallbackCwd,
          dangerousPermissions: false,
          permissionMode: ports.permissionMode?.current() ?? 'ask',
          ports,
          sandbox: welcomeSandboxFrom(await ports.native.probe()),
          sessionId: 'not available',
          trustLabel: 'not available',
        }),
      renderText: renderTextStatus,
    }),
    createMemoryCommand(io),
    createRemoteCommand(),
    tasksCommand,
    daemonCommand,
  ])
  if (subcommand && registry.has(subcommand))
    return registry.dispatch(subcommand, { args, cwd, ports })
  if (subcommand === 'version')
    return { exitCode: 0, stdout: `${stdout}${ports.identity.version}\n`, stderr }
  if (subcommand === 'help')
    return { exitCode: 0, stdout: `${stdout}${await renderGlobalUsage(command)}`, stderr }
  if (subcommand === 'hook' && args._[1] === 'list')
    return { exitCode: 0, stdout: `${stdout}No builtin hooks registered.\n`, stderr }
  if (subcommand === 'hook') {
    // 裸 `volund hook` / 未知动作此前会落到 "integration port is not connected"
    // 的误导性错误行——hook 是已知保留命令，给用法提示而不是端口错误。
    return { exitCode: 2, stdout, stderr: commandUsage['hook']! }
  }
  if (subcommand === 'plugin') {
    if (!ports.plugin) {
      const message = 'plugin integration port is not connected'
      return args.json
        ? jsonFailure(message, 2, 'plugin_integration_unavailable')
        : { exitCode: 2, stdout, stderr: message }
    }
    const action = args._[1] ?? 'list'
    try {
      if (action === 'list') {
        const [plugins, availability] = await Promise.all([
          ports.plugin.list(),
          ports.plugin.availability(),
        ])
        stdout += args.json
          ? `${JSON.stringify(
              Object.entries(plugins).map(([name, state]) =>
                Object.assign({}, state, {
                  name,
                  availability,
                  reasonCode: availability.code,
                }),
              ),
            )}\n`
          : `${Object.entries(plugins)
              .map(
                ([name, state]) =>
                  `${name}@${state.version}\tdisabled (legacy runtime unavailable)`,
              )
              .join('\n')}${Object.keys(plugins).length ? '\n' : ''}`
        return { exitCode: 0, stdout, stderr }
      }
      const target = args._[2]
      if (!target) {
        const message = `plugin ${action} requires a target`
        return args.json
          ? jsonFailure(message, 2, 'plugin_command_target_required', 'usage')
          : { exitCode: 2, stdout, stderr: message }
      }
      if (action === 'install') {
        const manifest = await ports.plugin.install(target)
        return {
          exitCode: 0,
          stdout: `${stdout}Installed ${manifest.name}@${manifest.version}.\n`,
          stderr,
        }
      }
      if (action === 'uninstall') {
        await ports.plugin.uninstall(target)
        return { exitCode: 0, stdout: `${stdout}Uninstalled ${target}.\n`, stderr }
      }
      if (action === 'enable' || action === 'disable') {
        await ports.plugin.setEnabled(target, action === 'enable')
        return {
          exitCode: 0,
          stdout: `${stdout}${action === 'enable' ? 'Enabled' : 'Disabled'} ${target}.\n`,
          stderr,
        }
      }
      if (action === 'doctor') {
        const report = await ports.plugin.doctor(target)
        stdout += `${
          args.json
            ? JSON.stringify(report)
            : `${report.name}@${report.version}\nPermissions: ${report.permissions.join(', ') || 'none'}\nCompatibility: ${report.compatibility.status}\n${report.compatibility.detail}\nAvailability: unavailable (${report.availability.code})\n${report.availability.detail}\nReopen requires: ${report.availability.reopenCondition}`
        }\n`
        return { exitCode: 0, stdout, stderr }
      }
      const message = `Unknown plugin action: ${action}`
      return args.json
        ? jsonFailure(message, 2, 'plugin_command_unknown', 'usage')
        : { exitCode: 2, stdout, stderr: message }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const candidateCode =
        error !== null &&
        typeof error === 'object' &&
        'code' in error &&
        typeof error.code === 'string'
          ? error.code
          : undefined
      const code =
        candidateCode && registeredPluginErrorCodes.has(candidateCode)
          ? candidateCode
          : 'plugin_internal_error'
      return args.json ? jsonFailure(message, 1, code) : { exitCode: 1, stdout, stderr: message }
    }
  }
  if (subcommand === 'plugins') {
    const action = args._[1] ?? 'builtin'
    // 创作工具链（.volund 打包面）：不依赖 localPlugins 端口，直接走 FS +
    // plugin-runtime 沙箱链路（crate/dev/build/install）。
    if (action === 'crate' || action === 'dev' || action === 'build' || action === 'install') {
      const authoring = { home: volundHome(), version: ports.identity.version }
      const dirArg = typeof args._[2] === 'string' ? args._[2] : undefined
      try {
        if (action === 'crate') {
          if (!dirArg)
            return { exitCode: 2, stdout, stderr: 'plugins crate requires a name or path' }
          const result = await cratePlugin(authoring, { target: dirArg, cwd })
          stdout += args.json
            ? `${JSON.stringify(result)}\n`
            : `Created ${result.name} in ${result.dir}\nNext: volund plugins dev ${result.dir}\n`
          return { exitCode: 0, stdout, stderr }
        }
        if (action === 'dev') {
          const result = await devPlugin(authoring, dirArg ?? cwd)
          if (args.json) stdout += `${JSON.stringify(result)}\n`
          else {
            const probeLine = result.probe.status === 'ok' ? 'ok' : `failed (${result.probe.error})`
            const names = (values: readonly string[]) =>
              values.length ? values.join(', ') : 'none'
            stdout +=
              [
                `${result.manifest.name}@${result.manifest.version}`,
                `probe: ${probeLine}`,
                `tools: ${names(result.contributions.tools)}`,
                `commands: ${names(result.contributions.commands)}`,
                `hooks: ${names(result.contributions.hooks)}`,
                `prompts: ${names(result.contributions.prompts)}`,
                `linked (${result.linked.mode}): ${result.linked.dir}`,
                'Takes effect in new sessions (REPL reloaded; daemon-spawned task subsessions pick it up automatically).',
              ].join('\n') + '\n'
          }
          if (args.watch) {
            // --watch（L4 hot reload）：初始探测直写 stdout，此后变更去抖重载；
            // 本分支长驻不返回（SIGINT 收尾），与 daemon 同款语义。
            for (const line of [stdout, 'watching for changes…']) process.stdout.write(`${line}\n`)
            await watchPluginDev(authoring, dirArg ?? cwd, {
              onReload: (reload) => process.stdout.write(`${devReloadLine(reload)}\n`),
            })
            return { exitCode: 0, stdout: '', stderr }
          }
          return { exitCode: result.probe.status === 'ok' ? 0 : 1, stdout, stderr }
        }
        if (action === 'build') {
          const result = await buildPlugin(
            dirArg ?? cwd,
            typeof args.output === 'string' ? args.output : undefined,
          )
          stdout += args.json
            ? `${JSON.stringify(result)}\n`
            : `${result.path}\nsha256 ${result.sha256}\n${result.entries.length} file(s), ${result.size} bytes\n`
          return { exitCode: 0, stdout, stderr }
        }
        if (!dirArg) {
          return {
            exitCode: 2,
            stdout,
            stderr: 'plugins install requires a .volund path or github:<owner>/<repo> spec',
          }
        }
        if (dirArg.startsWith('github:')) {
          const result = await installGithubSpec(authoring, dirArg)
          stdout += args.json
            ? `${JSON.stringify(result)}\n`
            : `Installed ${result.name}@${result.version} (${result.source}@${result.tag}) → ${result.dir}\nPublisher signature verified; takes effect in new sessions.\n`
          return { exitCode: 0, stdout, stderr }
        }
        const result = await installVolundArchive(authoring, dirArg)
        stdout += args.json
          ? `${JSON.stringify(result)}\n`
          : `Installed ${result.name}@${result.version} → ${result.dir}\nTakes effect in new sessions.\n`
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string }).code
        return args.json
          ? jsonFailure(message, 1, code ?? 'plugins_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (action === 'trust') {
      // 发布者公钥钉存（github: 安装的信任根）：无自动 TOFU——key 必须由用户
      // 带外核验后显式钉入 ~/.volund/plugins-trust.json。
      const home = volundHome()
      const source = typeof args._[2] === 'string' ? args._[2] : undefined
      try {
        if (!source || source === '--list' || source === 'list') {
          const store = await readPluginTrustStore(home)
          const entries = Object.entries(store.publishers)
          stdout += args.json
            ? `${JSON.stringify(Object.fromEntries(entries))}\n`
            : entries.length
              ? `${entries.map(([id, entry]) => `${id}\t${entry.ed25519}`).join('\n')}\n`
              : 'no publishers pinned (volund plugins trust <source> --key <base64url>)\n'
          return { exitCode: 0, stdout, stderr }
        }
        const key = typeof args.key === 'string' ? args.key : undefined
        if (!key)
          return {
            exitCode: 2,
            stdout,
            stderr: 'plugins trust requires --key <ed25519 public key base64url>',
          }
        await pinPluginPublisher(home, source, key)
        stdout += args.json ? `${JSON.stringify({ source, pinned: true })}\n` : `Pinned ${source}\n`
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string }).code
        return args.json
          ? jsonFailure(message, 1, code ?? 'plugins_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (action === 'upgrade') {
      const names = args._.slice(2).filter((entry): entry is string => typeof entry === 'string')
      if (names.length === 0 && !args.all)
        return { exitCode: 2, stdout, stderr: 'plugins upgrade requires a plugin name or --all' }
      try {
        const rows = await upgradePlugins({
          home: volundHome(),
          volundVersion: ports.identity.version,
          ...(names.length ? { names } : {}),
        })
        stdout += args.json
          ? `${JSON.stringify(rows)}\n`
          : rows.length
            ? `${rows
                .map(
                  (row) =>
                    `${row.channel}\t${row.name}\t${row.from} → ${row.to ?? '-'}\t${row.status}${row.detail ? ` (${row.detail})` : ''}`,
                )
                .join('\n')}\n`
            : 'nothing upgradable (no market/github installed plugins)\n'
        return { exitCode: rows.some((row) => row.status === 'failed') ? 1 : 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const code = (error as { code?: string }).code
        return args.json
          ? jsonFailure(message, 1, code ?? 'plugins_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (!ports.localPlugins)
      return { exitCode: 2, stdout, stderr: 'local plugin port is not connected' }
    if (action !== 'builtin') {
      return {
        exitCode: 2,
        stdout,
        stderr: `Unknown plugins action: ${action} (available: builtin, crate, dev, build, install, trust, upgrade)`,
      }
    }
    try {
      // volund plugins builtin [--enable <id> | --disable <id>]：第一方工具域
      // 可见可禁用（落 [plugins] builtin_disabled，新会话生效）。
      const enable = typeof args.enable === 'string' ? args.enable : undefined
      const disable = typeof args.disable === 'string' ? args.disable : undefined
      if (enable) await ports.localPlugins.setBuiltinDomain(enable, true)
      if (disable) await ports.localPlugins.setBuiltinDomain(disable, false)
      const domains = await ports.localPlugins.builtinDomains()
      stdout += args.json
        ? `${JSON.stringify(domains)}\n`
        : `${domains
            .map((domain) => {
              const state = domain.enabled ? 'enabled' : 'disabled'
              const flag =
                enable === domain.id ? ' (enabled)' : disable === domain.id ? ' (disabled)' : ''
              return `${domain.id}\t${state}${flag}\t${domain.label}: ${domain.description}`
            })
            .join('\n')}\n`
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return args.json
        ? jsonFailure(message, 1, 'plugins_action_failed')
        : { exitCode: 1, stdout, stderr: message }
    }
  }
  if (subcommand === 'mcp') {
    if (!ports.mcp) return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
    const action = args._[1] ?? 'list'
    if (action === 'list') {
      const servers = await ports.mcp.list()
      stdout += args.json
        ? `${JSON.stringify(servers)}\n`
        : `${servers
            .map(
              (server) =>
                `${server.name}\t${server.status ?? 'configured'}\t${server.scope ?? ''}\t${redactTransport(server.transport)}`,
            )
            .join('\n')}${servers.length ? '\n' : ''}`
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'test' || action === 'inspect') {
      const name = args._[2]
      if (!name) return { exitCode: 2, stdout, stderr: `mcp ${action} requires a server name` }
      try {
        if (action === 'test') {
          const result = await ports.mcp.test(name, AbortSignal.timeout(10_000))
          stdout += `${args.json ? JSON.stringify(result) : `Connected (${result.protocolVersion})`}\n`
        } else {
          const result = await ports.mcp.inspect(name, AbortSignal.timeout(10_000))
          stdout += `${args.json ? JSON.stringify(result) : result.tools.map((tool) => `${tool.name}${tool.description ? ` — ${tool.description}` : ''}`).join('\n')}\n`
        }
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        return {
          exitCode: 1,
          stdout,
          stderr: error instanceof Error ? error.message : String(error),
        }
      }
    }
    if (action === 'add') {
      if (!ports.mcp)
        return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
      // 'add' 是第二个位置参数，按 citty 的 value-flag 消费口径定位它的真实
      // 下标——字面量搜索（indexOf('add')）会被 `--model add mcp add …` 这类
      // 旗标值恰好等于动作名的输入错切。
      const addIndex = nthPositionalIndex(rawArgs, 2)
      const parsed = parseMcpAddArgs(addIndex === -1 ? [] : rawArgs.slice(addIndex + 1))
      if (parsed.error)
        return args.json
          ? jsonFailure(parsed.error, 2, 'mcp_add_invalid', 'usage')
          : { exitCode: 2, stdout, stderr: parsed.error }
      try {
        const result = await ports.mcp.add(parsed.input!)
        stdout += args.json
          ? `${JSON.stringify(result)}\n`
          : `Added MCP server ${parsed.input!.name} (${parsed.input!.transport.kind}) to ${result.file}\n`
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return args.json
          ? jsonFailure(message, 1, 'mcp_add_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (action === 'remove' || action === 'enable' || action === 'disable') {
      if (!ports.mcp)
        return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
      const name = args._[2]
      if (!name) return { exitCode: 2, stdout, stderr: `mcp ${action} requires a server name` }
      const scope = args.scope === 'project' || args.scope === 'user' ? args.scope : undefined
      try {
        if (action === 'remove') {
          const result = await ports.mcp.remove(name, scope)
          stdout += args.json
            ? `${JSON.stringify(result)}\n`
            : `Removed MCP server ${name} from ${result.file}\n`
        } else {
          await ports.mcp.setEnabled(name, action === 'enable')
          stdout += `MCP server ${name} ${action}d\n`
        }
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return args.json
          ? jsonFailure(message, 1, 'mcp_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (action === 'login' || action === 'logout') {
      if (!ports.mcp)
        return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
      const name = args._[2]
      if (!name) return { exitCode: 2, stdout, stderr: `mcp ${action} requires a server name` }
      try {
        if (action === 'login') {
          await ports.mcp.login(name)
          stdout += `Authorized ${name}; stored the token in the credential store\n`
        } else {
          await ports.mcp.logout(name)
          stdout += `Logged out ${name}; cleared stored credentials\n`
        }
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return args.json
          ? jsonFailure(message, 1, 'mcp_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    if (action === 'approve') {
      if (!ports.mcp?.approveTools) {
        return { exitCode: 2, stdout, stderr: 'mcp integration port is not connected' }
      }
      const name = args._[2]
      if (!name) return { exitCode: 2, stdout, stderr: 'mcp approve requires a server name' }
      try {
        const result = await ports.mcp.approveTools(name)
        stdout += `Approved ${result.tools} tool(s) from ${name}; calls are unblocked\n`
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return args.json
          ? jsonFailure(message, 1, 'mcp_action_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    return { exitCode: 2, stdout, stderr: `Unknown mcp action: ${action}` }
  }
  if (subcommand === 'skill') {
    if (!ports.skill)
      return { exitCode: 2, stdout, stderr: 'skill integration port is not connected' }
    const action = args._[1] ?? 'list'
    const scope = args.scope === 'project' || args.scope === 'user' ? args.scope : undefined
    try {
      if (action === 'list') {
        const skills = await ports.skill.list()
        const visible = scope ? skills.filter((skill) => skill.scope === scope) : skills
        stdout += args.json
          ? `${JSON.stringify(visible)}\n`
          : `${visible
              .map(
                (skill) =>
                  `${skill.name}\t${skill.scope}:${skill.status}\t${skill.description.split('\n', 1)[0] ?? ''}`,
              )
              .join('\n')}${visible.length ? '\n' : ''}`
        return { exitCode: 0, stdout, stderr }
      }
      if (action === 'install') {
        const spec = args._[2]
        if (!spec)
          return {
            exitCode: 2,
            stdout,
            stderr:
              'skill install requires a source (local dir, git URL, github:owner/repo, or owner/repo)',
          }
        const installed = await ports.skill.install(spec, scope ? { scope } : undefined)
        stdout += args.json
          ? `${JSON.stringify(installed)}\n`
          : `Installed ${installed.length} skill(s):\n${installed.map((skill) => `  ${skill.name} (${skill.scope} · ${skill.path})`).join('\n')}\n`
        return { exitCode: 0, stdout, stderr }
      }
      if (action === 'uninstall') {
        const name = args._[2]
        if (!name) return { exitCode: 2, stdout, stderr: 'skill uninstall requires a name' }
        await ports.skill.uninstall(name, scope ? { scope } : undefined)
        stdout += `Uninstalled skill ${name}\n`
        return { exitCode: 0, stdout, stderr }
      }
      if (action === 'show') {
        const name = args._[2]
        if (!name) return { exitCode: 2, stdout, stderr: 'skill show requires a name' }
        stdout += `${await ports.skill.show(name)}\n`
        return { exitCode: 0, stdout, stderr }
      }
      if (action === 'enable' || action === 'disable') {
        const name = args._[2]
        if (!name) return { exitCode: 2, stdout, stderr: `skill ${action} requires a name` }
        await ports.skill.setEnabled(name, action === 'enable')
        stdout += `Skill ${name} ${action}d\n`
        return { exitCode: 0, stdout, stderr }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return args.json
        ? jsonFailure(message, 1, 'skill_command_failed')
        : { exitCode: 1, stdout, stderr: message }
    }
    return { exitCode: 2, stdout, stderr: `Unknown skill action: ${action}` }
  }
  if (subcommand === 'context') {
    if (!ports.context)
      return { exitCode: 2, stdout, stderr: 'context integration port is not connected' }
    const action = args._[1] ?? 'show'
    if (action === 'show') {
      const status = await ports.context.show()
      stdout += args.json
        ? `${JSON.stringify(status)}\n`
        : `Policy: ${status.policy}\nTokens: ${status.currentTokens} / ${status.maxTokens}\nCompaction threshold: ${Math.round(status.threshold * 100)}%\nSources: ${Object.entries(
            status.sources,
          )
            .map(([key, value]) => `${key}=${value}`)
            .join(', ')}\n`
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'diff') {
      const status = await ports.context.show()
      stdout += status.lastCompaction
        ? `${status.lastCompaction.compactedMessageIds.join('\n')}\n`
        : 'No compaction recorded.\n'
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'keep' || action === 'unkeep') {
      const target = args._[2]
      if (!target)
        return { exitCode: 2, stdout, stderr: `context ${action} requires a message or turn id` }
      await ports.context[action](target)
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'compact') {
      const value = args._[2]
      if (value && value !== 'sliding' && value !== 'summary')
        return { exitCode: 2, stdout, stderr: `Unsupported context strategy: ${value}` }
      const result = await ports.context.compact(value as 'sliding' | 'summary' | undefined)
      return {
        exitCode: 0,
        stdout: `${stdout}Compacted: ${result.beforeTokens} → ${result.afterTokens} tokens\n`,
        stderr,
      }
    }
    if (action === 'policy' && (args._[2] ?? 'get') === 'get') {
      const policy = await ports.context.getPolicy()
      return {
        exitCode: 0,
        stdout: `${stdout}${args.json ? JSON.stringify(policy) : `${policy.name} ${JSON.stringify(policy.params)}`}\n`,
        stderr,
      }
    }
    if (action === 'policy' && args._[2] === 'set') {
      const name = args._[3]
      if (!name) return { exitCode: 2, stdout, stderr: 'context policy set requires a name' }
      const params = Object.fromEntries(
        args._.slice(4).map((entry) => {
          const [key, ...rest] = entry.split('=')
          return [key!, rest.join('=')]
        }),
      )
      await ports.context.setPolicy(name, params)
      return { exitCode: 0, stdout, stderr }
    }
    return { exitCode: 2, stdout, stderr: `Unknown context action: ${action}` }
  }
  if (subcommand === 'evolution') {
    if (!ports.evolution)
      return { exitCode: 2, stdout, stderr: 'evolution integration port is not connected' }
    const action = args._[1] ?? 'show'
    const namespace = args.namespace ? String(args.namespace) : undefined
    const namespaces = ['context', 'router', 'retry', 'tool-timeout'] as const
    if (namespace && !namespaces.includes(namespace as (typeof namespaces)[number]))
      return { exitCode: 2, stdout, stderr: `Unsupported evolution namespace: ${namespace}` }
    if (action === 'show') {
      const records = await ports.evolution.show({
        ...(namespace ? { namespace } : {}),
        ...(args.since ? { since: new Date(String(args.since)) } : {}),
      })
      stdout += args.json
        ? `${JSON.stringify(records)}\n`
        : records.length
          ? `${records.map((record) => JSON.stringify(record)).join('\n')}\n`
          : 'No evolution adjustments recorded.\n'
      return { exitCode: 0, stdout, stderr }
    }
    if (action === 'rollback') {
      const records = await ports.evolution.rollback({
        namespace: (namespace as (typeof namespaces)[number] | undefined) ?? 'context',
        ...(args.to ? { to: new Date(String(args.to)) } : {}),
      })
      stdout += `Rolled back ${records.length} parameter(s).\n`
      return { exitCode: 0, stdout, stderr }
    }
    return { exitCode: 2, stdout, stderr: `Unknown evolution action: ${action}` }
  }
  if (subcommand === 'resume') {
    const id = args._[1]
    if (id) {
      try {
        await ports.session.resume(id)
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        return jsonMode
          ? jsonFailure(message, 1, 'session_resume_failed')
          : { exitCode: 1, stdout, stderr: message }
      }
    }
    const candidates = (await ports.session.list?.()) ?? []
    if (jsonMode || noTui || !io.isInteractiveTerminal?.() || !ports.ui?.renderSessionPicker) {
      const message = 'resume requires a session id outside an interactive TTY'
      return jsonMode
        ? {
            exitCode: 2,
            stdout: `${JSON.stringify({ ok: false, error: { code: 'session_id_required', message }, candidates })}\n`,
            stderr: '',
          }
        : {
            exitCode: 2,
            stdout,
            stderr: `${message}. Candidates: ${candidates.map((item) => item.id).join(', ') || 'none'}`,
          }
    }
    const selected = await ports.ui.renderSessionPicker({ sessions: candidates })
    if (!selected) return { exitCode: 0, stdout, stderr }
    if (ports.session.resumeInteractive) {
      resumeSelection = selected
      cwd = selected.cwd
    } else {
      try {
        await ports.session.resume(selected.id)
        return { exitCode: 0, stdout, stderr }
      } catch (error) {
        return {
          exitCode: 1,
          stdout,
          stderr: `Could not resume ${selected.id}: ${error instanceof Error ? error.message : String(error)}`,
        }
      }
    }
  }
  if (subcommand === 'restore') {
    const id = args._[1]
    if (!id) return { exitCode: 2, stdout, stderr: 'restore requires a session id' }
    if (!ports.restore)
      return { exitCode: 2, stdout, stderr: 'restore integration port is not connected' }
    try {
      const restored = await ports.restore.restore(id, { dryRun: Boolean(args.dryRun) })
      if (restored.missing)
        return { exitCode: 1, stdout, stderr: `No backups found for session: ${id}` }
      if (restored.conflicts.length)
        return {
          exitCode: 1,
          stdout,
          stderr: `Restore refused because files changed after the session:\n${restored.conflicts.join('\n')}`,
        }
      stdout += `${restored.dryRun ? 'Would restore' : 'Restored'} ${restored.restored.length} file(s)\n`
      for (const path of restored.restored) stdout += `${path}\n`
      return { exitCode: 0, stdout, stderr }
    } catch (error) {
      return { exitCode: 1, stdout, stderr: error instanceof Error ? error.message : String(error) }
    }
  }
  if (subcommand === 'login') {
    const provider = args._[1] ?? 'anthropic'
    if (provider !== 'anthropic')
      return { exitCode: 2, stdout, stderr: `Unsupported provider: ${provider}` }
    if (args.skipVerify && !args.dangerous)
      return { exitCode: 2, stdout, stderr: '--skip-verify requires --dangerous' }
    const credential = args.apiKeyStdin ? (await io.readStdin()).trim() : undefined
    if (args.apiKeyStdin && !credential)
      return { exitCode: 2, stdout, stderr: 'No credential received on stdin' }
    try {
      const result = await ports.auth.login({
        provider,
        ...(credential === undefined ? {} : { credential }),
        flow: args.apiKeyStdin ? 'stdin' : 'api-key',
        dangerouslySkipVerify: Boolean(args.skipVerify),
      })
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Login failed',
      }
    }
  }
  if (subcommand === 'logout') {
    const provider = args._[1] ?? 'anthropic'
    try {
      const result = await ports.auth.logout(provider)
      return { exitCode: 0, stdout: `${stdout}${result.detail}\n`, stderr }
    } catch (error) {
      return {
        exitCode: 1,
        stdout,
        stderr: error instanceof Error ? error.message : 'Logout failed',
      }
    }
  }
  if (subcommand !== undefined && subcommand !== 'chat' && !resumeSelection)
    return {
      exitCode: 2,
      stdout,
      stderr: `${subcommand} integration port is not connected in the L1 shell.`,
    }
  // [env] 段（§8.3 / 附录 C）：会话级环境变量在信任门与 native probes 之前写入
  // process.env，之后 spawn 的子进程（native worker / 插件宿主 / MCP stdio）都能
  // 继承到配置值。管理类子命令（doctor/status/...）已在上方 dispatch 走掉、不经
  // 此处，因此 [env] 类型错时 volund doctor 仍可用于诊断（C.1：类型错启动 fail）。
  try {
    await ports.config.applyEnv?.()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return jsonMode
      ? jsonFailure(message, 1, 'config_invalid')
      : { exitCode: 1, stdout, stderr: message }
  }
  const rawPrompt =
    subcommand === 'chat' ? args._.slice(1).join(' ') : resumeSelection ? '' : args._.join(' ')
  const prompt = rawPrompt || undefined
  if (jsonMode && !prompt)
    return jsonFailure('JSON chat requires a prompt.', 2, 'prompt_required', 'usage')
  const interactiveTrustPrompt =
    prompt === undefined &&
    !jsonMode &&
    !noTui &&
    Boolean(io.isInteractiveTerminal?.()) &&
    Boolean(ports.ui?.renderDirectoryTrustPrompt)
  let trustCheck
  try {
    trustCheck = await ports.trust.check(cwd)
  } catch (error) {
    const message = `Unable to check directory trust: ${error instanceof Error ? error.message : String(error)}`
    return jsonMode
      ? jsonFailure(message, 2, 'trust_store_unavailable', 'security')
      : { exitCode: 2, stdout, stderr: message }
  }
  cwd = trustCheck.canonicalPath
  let trustLabel = trustCheck.trusted
    ? trustCheck.scope === 'tree'
      ? trustCheck.matchedPath === cwd
        ? 'Trusted: folder/**'
        : 'Trusted: parent/**'
      : 'Trusted: folder'
    : 'Untrusted'
  if (!trustCheck.trusted) {
    try {
      if (args.trustWorkspace) {
        await ports.trust.grant(cwd, 'exact')
        trustLabel = 'Trusted: folder'
        await ports.telemetry.securityEvent('directory.trusted', { cwd, scope: 'exact' })
      } else if (interactiveTrustPrompt) {
        const decision = await ports.ui!.renderDirectoryTrustPrompt!({
          canonicalPath: cwd,
          parentPath: dirname(cwd),
        })
        if (decision === 'exit') {
          await ports.telemetry.securityEvent('directory.trust_denied', { cwd })
          return {
            exitCode: 1,
            stdout,
            stderr: 'Directory was not trusted; nothing was started.',
          }
        }
        const target = decision === 'parent' ? dirname(cwd) : cwd
        const scope = decision === 'current' ? 'exact' : 'tree'
        await ports.trust.grant(target, scope)
        trustLabel =
          decision === 'parent'
            ? 'Trusted: parent/**'
            : decision === 'current'
              ? 'Trusted: folder'
              : 'Trusted: folder/**'
        await ports.telemetry.securityEvent('directory.trusted', { cwd: target, scope })
      } else {
        const message = `Directory is not trusted: ${cwd}. Re-run with --trust-workspace to trust this exact folder, or use an interactive terminal.`
        return jsonMode
          ? jsonFailure(message, 1, 'directory_untrusted', 'security')
          : { exitCode: 1, stdout, stderr: message }
      }
    } catch (error) {
      const message = `Unable to persist directory trust: ${error instanceof Error ? error.message : String(error)}`
      return jsonMode
        ? jsonFailure(message, 2, 'trust_store_unavailable', 'security')
        : { exitCode: 2, stdout, stderr: message }
    }
  }
  const dangerousModes: DangerousMode[] = []
  if (args.yolo || args.dangerouslySkipPermissions) {
    dangerousModes.push('skip-permissions')
    await ports.telemetry.securityEvent('permissions.dangerously_skipped', { cwd })
  }
  if (args.dangerousNoSandbox) {
    dangerousModes.push('no-sandbox')
    await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
    if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
      return {
        exitCode: 1,
        stdout,
        stderr: 'Dangerous no-sandbox mode requires typing: I understand the risk',
      }
  }
  // r13-P1 startup contract (spec 05-rust-sidecar.md §5.8): every native probe
  // fires now, in parallel; the interactive REPL never awaits them — the UI
  // starts with a 'probing' sandbox badge that backfills when the probe
  // settles. Only the opt-in strict gate and the deterministic non-interactive
  // path block on the probe.
  ports.native.startProbes?.()
  const probePromise = ports.native.probe()
  probePromise.catch(() => undefined)
  const shouldUseTui =
    prompt === undefined &&
    !jsonMode &&
    !noTui &&
    Boolean(io.isInteractiveTerminal?.()) &&
    Boolean(ports.ui?.renderInteractiveApp) &&
    Boolean(resumeSelection ? ports.session.resumeInteractive : ports.session.startInteractive)
  if (!shouldUseTui) {
    const probe = await probePromise
    if (args.strictSandbox && probe.tier !== 'full') {
      const message = `Full sandbox required; detected ${probe.tier}.`
      return jsonMode
        ? jsonFailure(message, 3, 'sandbox_unavailable')
        : { exitCode: 3, stdout, stderr: message }
    }
    if (probe.tier === 'none' && !args.dangerousNoSandbox) {
      await ports.telemetry.securityEvent('sandbox.probe.failed', {
        cwd,
        mechanism: probe.mechanism,
      })
      if (!(await ports.confirmation.confirmDangerousNoSandbox('I understand the risk')))
        return {
          exitCode: 1,
          stdout,
          stderr: 'None-tier sandbox requires typing: I understand the risk',
        }
      dangerousModes.push('no-sandbox')
      await ports.telemetry.securityEvent('sandbox.dangerously_disabled', { cwd })
    }
  }
  const banner = renderSecurityBanner(dangerousModes, !noColor)
  if (banner && !shouldUseTui) stdout += `${banner}\n`
  const permissionInteractionMode = jsonMode
    ? 'none'
    : shouldUseTui
      ? 'tui'
      : io.isInteractiveTerminal?.()
        ? 'line'
        : 'none'
  ports.session.configureSecurity?.({
    skipPermissions: Boolean(args.yolo || args.dangerouslySkipPermissions),
  })
  // §4.4 三档模式：--yolo 等价 full；--permission-mode <ask|auto|full> 配置新会话默认档。
  // 形状校验已前移到 --budget 旁做 fail-fast（信任门/沙箱确认之前）；这里只做覆盖。
  {
    const flagMode =
      args.permissionMode === 'ask' ||
      args.permissionMode === 'auto' ||
      args.permissionMode === 'full'
        ? args.permissionMode
        : undefined
    // 显式 flag 才覆盖；否则落到 [permissions] mode 用户级 config 或默认 ask
    if (args.yolo || args.dangerouslySkipPermissions) ports.permissionMode?.set('full')
    else if (flagMode) ports.permissionMode?.set(flagMode)
  }
  ports.session.configurePermissionInteraction?.({ mode: permissionInteractionMode })
  ports.session.configureOutput?.({ json: jsonMode, write: (value) => (stdout += value) })
  ports.session.configureTerminalOutput?.({ streamToStdout: !jsonMode && !shouldUseTui })
  try {
    if (shouldUseTui) {
      // --strict-sandbox is an explicit opt-in hard gate, so it may block on
      // the probe; the plain REPL path never does.
      if (args.strictSandbox) {
        const probe = await probePromise
        if (probe.tier !== 'full')
          return {
            exitCode: 3,
            stdout,
            stderr: `Full sandbox required; detected ${probe.tier}.`,
          }
      }
      const interactive = resumeSelection
        ? await ports.session.resumeInteractive!(resumeSelection.id)
        : await ports.session.startInteractive!({
            cwd,
            ...(typeof args.model === 'string' && args.model ? { model: args.model } : {}),
            ...(taskBudget ? { budget: taskBudget } : {}),
            ...(taskTools && taskTools.length > 0 ? { allowedTools: taskTools } : {}),
            ...(taskRun ? { taskRun } : {}),
          })
      // PLUGIN-STATUS-UI-r1 / PLUGIN-MANAGER-r1 本地插件装载：内置插件（产物自带
      // 的 apps/cli/plugins/，如 /env、/plugins）先装载；dev 插件随后
      // （~/.volund/plugins-dev 约定目录 + VOLUND_DEV_PLUGINS=<dir>[,<dir>...] 的
      // 仓库内开发路径）；市场插件最后（~/.volund/plugins/<name>/，装自 [plugins]
      // market，激活时逐文件重验 digest）。单个失败不阻塞 REPL。插件激活失败必须
      // 进 TUI 可见的启动系统消息（notices）——只写 stderr 的话要等 REPL 退出才
      // 显示，/env 这类命令就会静默缺失成 "Unknown slash command"。
      const startupNotices: string[] = []
      if (ports.localPlugins) {
        const { failed: builtinFailed } = await ports.localPlugins.loadBuiltinPlugins()
        for (const failure of builtinFailed)
          startupNotices.push(
            `Builtin plugin ${basename(failure.dir)} failed to activate: ${failure.error}`,
          )
        const extraDirs = (process.env.VOLUND_DEV_PLUGINS ?? '')
          .split(',')
          .map((dir) => dir.trim())
          .filter(Boolean)
        const { failed: devFailed } = await ports.localPlugins.loadDevPlugins(extraDirs)
        for (const failure of devFailed) {
          const note = `Dev plugin ${failure.dir} failed to activate: ${failure.error}`
          startupNotices.push(note)
          stderr += `${note}\n`
        }
        const { failed: marketFailed } = await ports.localPlugins.loadMarketPlugins()
        for (const failure of marketFailed) {
          const note = `Market plugin ${basename(failure.dir)} failed to activate: ${failure.error}`
          startupNotices.push(note)
          stderr += `${note}\n`
        }
      }
      // §22 W-07 多路审批：TUI 与 Web 共享进程级队列（runtime 已把它接进权限链），
      // 任一端决策全端清卡；无共享队列的宿主退回本地实例。
      const permissions = ports.permissionPrompts ?? new PermissionPromptController()
      if (!(args.yolo || args.dangerouslySkipPermissions))
        interactive.setPermissionPromptHandler?.((request, signal) =>
          permissions.request(request, signal),
        )
      const permissionsBypassed = Boolean(args.yolo || args.dangerouslySkipPermissions)
      // §22 W-01：静默自启 Web 控制台（挂载本会话；[web] enabled=false / VOLUND_WEB=0
      // 关闭）——在欢迎屏组装前完成，地址直接上屏；失败进启动 notices，不阻塞 TUI。
      let webConsole: { url: string; port: number; close(): Promise<void> } | undefined
      if (ports.web?.startEmbedded) {
        try {
          webConsole = await ports.web.startEmbedded({ cwd })
        } catch (cause) {
          startupNotices.push(
            `Web console failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      }
      // REM-r1：[remote] enabled → 远程控制 uplink 自动拨出（失败进 notices 不阻塞 TUI）。
      if (ports.remoteControl) {
        try {
          await ports.remoteControl.startup({ cwd })
        } catch (cause) {
          startupNotices.push(
            `Remote control failed to start: ${cause instanceof Error ? cause.message : String(cause)}`,
          )
        }
      }
      // W-17 r1.4 开关自愈：enabled=true 而 daemon 不在场 → 补拉一次（detached，
      // TUI 退出不带走）。失败进 notices 不阻塞 TUI。
      try {
        const merged = await ports.config.listMerged?.({ cwd })
        const tasksSection = merged?.config?.['tasks'] as { enabled?: unknown } | undefined
        if (tasksSection?.enabled === true) {
          const daemonHome = process.env.VOLUND_HOME ?? join(homedir(), '.volund')
          if (
            !(await readDaemonStatus(daemonHome)).running &&
            spawnDetachedDaemon(daemonHome, { cwd })
          ) {
            startupNotices.push('Task scheduler enabled: daemon started in background.')
          }
        }
      } catch {
        // 自愈尽力而为：读不到配置/锁就不动。
      }
      // uplink 启动快照进欢迎屏（多半还是 connecting——online 后经 remoteStatus
      // 订阅回填）；'off' 即未启用，不渲染 remote 行。
      const remoteSnapshot = ((): WelcomePanelData['remote'] => {
        const status = ports.remoteControl?.status()
        if (!status || status.state === 'off') return undefined
        return {
          state: status.state,
          ...(status.gatewayUrl ? { url: status.gatewayUrl } : {}),
        }
      })()
      // 模型展示对齐 §8.3 实际生效值：status 端口的 Model 行已按
      // options.model → preferences.model → provider.anthropic.model 收口。
      // picker/welcome 不再写死 defaultInteractiveModel（否则企业网关自定义模型时
      // UI 显示与实际发送的模型脱节）。
      const resolvedStatusPanel = ports.config.status
        ? await ports.config.status({ cwd, sessionId: interactive.id })
        : undefined
      const configuredModel = resolvedStatusPanel?.status.find(
        (row) => row.label === 'Model',
      )?.value
      // resume 恢复的会话钉住模型（/model 选择落盘的 provider/model id）优先于
      // 全局配置生效值——picker 的 currentModelId 与会话实际使用的模型对齐。
      const effectiveModelId =
        interactive.model ??
        (configuredModel
          ? configuredModel.startsWith('anthropic/')
            ? configuredModel
            : `anthropic/${configuredModel}`
          : defaultInteractiveModel)
      const welcome = await buildWelcomePanelData({
        cwd,
        dangerousPermissions: permissionsBypassed,
        permissionMode: ports.permissionMode?.current() ?? (permissionsBypassed ? 'full' : 'ask'),
        ports,
        sandbox: { status: 'probing' },
        sessionId: interactive.id,
        trustLabel,
        ...(webConsole ? { webUrl: webConsole.url } : {}),
        ...(remoteSnapshot ? { remote: remoteSnapshot } : {}),
        ...(configuredModel
          ? {
              model: {
                status: 'available' as const,
                provider: 'anthropic',
                model: configuredModel.replace(/^anthropic\//, ''),
                source: 'config' as const,
              },
            }
          : {}),
      })
      const modelAliases: Record<string, { provider: string; model: string }> = {}
      try {
        const merged = await ports.config.listMerged?.({ cwd })
        // [models.aliases] 在合并配置里位于 models.aliases（§8.3）。
        const table = merged?.config.models
        const aliases =
          table &&
          typeof table === 'object' &&
          !Array.isArray(table) &&
          typeof (table as Record<string, unknown>).aliases === 'object'
            ? ((table as Record<string, unknown>).aliases as Record<string, unknown>)
            : undefined
        if (aliases)
          for (const [name, value] of Object.entries(aliases))
            if (
              value &&
              typeof value === 'object' &&
              typeof (value as { model?: unknown }).model === 'string'
            ) {
              const entry = value as { provider?: unknown; model: string }
              modelAliases[name] = {
                provider: typeof entry.provider === 'string' ? entry.provider : 'anthropic',
                model: entry.model,
              }
            }
      } catch {
        // 别名装取失败不阻塞 REPL——picker 只少几个候选。
      }
      const app = ports.ui!.renderInteractiveApp({
        cwd,
        events: interactive.events,
        ...(ports.permissionMode ? { permissionMode: ports.permissionMode } : {}),
        ...(ports.memory
          ? {
              memory: createMemoryPanelController(
                ports.memory,
                ports.memoryRecall,
                projectMemoryScope(cwd),
              ),
            }
          : {}),
        noColor,
        notices: startupNotices,
        onExit: interactive.end,
        ...(interactive.interrupt ? { onInterrupt: () => interactive.interrupt!() } : {}),
        // §7.5.2：Ctrl+V 剪贴板附件（图片落盘/文件引用）；headless 会话不实现该口。
        ...(interactive.pasteClipboardAttachment
          ? { onPasteAttachment: () => interactive.pasteClipboardAttachment!() }
          : {}),
        // §7.5.2：粘贴/拖拽文件路径转附件（bracketed paste 文本解析）。
        ...(interactive.attachFilePath
          ? { onAttachFilePath: (path: string) => interactive.attachFilePath!(path) }
          : {}),
        // §7.5.3：@ picker 的文件候选源。
        ...(interactive.listFiles ? { listFiles: () => interactive.listFiles!() } : {}),
        onSubmit: interactive.submit,
        // 队列补发等锁：turn 终态事件先于互斥释放出站，补发先 whenTurnSettled 再
        // submit（缺省 = 旧宿主 facade，TUI 按直接提交回退）。
        ...(interactive.whenTurnSettled
          ? { whenTurnSettled: () => interactive.whenTurnSettled!() }
          : {}),
        // /model 选择落盘：钉住会话级模型（session.model_changed 事件进 jsonl），
        // resume 时由 replay 还原——模型选择不再只活在 TUI 内存里。
        onModelSelect: (model) => ports.session.setModel?.(model),
        // [models.aliases] 进 picker：别名（如 vision → anthropic/mimo-v2.5）可当
        // 轮显式切换——贴图碰到不支持视觉的模型时用它切到视觉模型。
        modelPicker: buildModelPicker(effectiveModelId, configuredModel, modelAliases),
        permissions,
        // AskUserQuestion 的共享提问队列：TUI 选项卡与 Web/Mobile 问答卡同源，
        // 任一端作答全端清卡；无共享队列的宿主不挂卡片。
        ...(ports.askPrompts ? { asks: ports.askPrompts } : {}),
        // 沙箱探针 + search/fs worker 探针并行跑；等全部 settle（预算封顶 5s）
        // 一次性回填，避免欢迎屏 native 状态停在 probing 或闪烁两跳。
        // tier 不上状态行（Mark 拍板：macOS 常驻 partial 只是噪音）——欢迎屏
        // Native modules 行与 /status 面板承载展示；仅 none（真不可用）示警。
        sandboxProbe: () =>
          Promise.all([probePromise, ports.native.settled?.() ?? Promise.resolve()]).then(
            ([probe]) => {
              const native = welcomeNativeFrom(ports)
              return {
                sandbox: welcomeSandboxFrom(probe),
                ...(native ? { native } : {}),
                status: probe.tier === 'none' ? 'sandbox unavailable' : 'ready',
              }
            },
          ),
        // facade → TUI 会话形状的统一映射（/resume 与 web 驱动激活共用）。
        ...(ports.session.list && ports.session.resumeInteractive
          ? (() => {
              const mapResumed = (resumed: import('./ports').InteractiveSession) => ({
                cwd: resumed.cwd ?? cwd,
                events: resumed.events,
                id: resumed.id,
                onExit: resumed.end,
                // 会话钉住模型（resume 恢复）→ TUI picker/提交通道回填。
                ...(resumed.model ? { model: resumed.model } : {}),
                ...(resumed.interrupt ? { onInterrupt: () => resumed.interrupt!() } : {}),
                ...(resumed.pasteClipboardAttachment
                  ? { onPasteAttachment: () => resumed.pasteClipboardAttachment!() }
                  : {}),
                ...(resumed.attachFilePath
                  ? { onAttachFilePath: (path: string) => resumed.attachFilePath!(path) }
                  : {}),
                ...(resumed.listFiles ? { listFiles: () => resumed.listFiles!() } : {}),
                onSubmit: resumed.submit,
                ...(resumed.whenTurnSettled
                  ? { whenTurnSettled: () => resumed.whenTurnSettled!() }
                  : {}),
                ...(resumed.transcript ? { transcript: resumed.transcript } : {}),
              })
              return {
                resume: {
                  list: () => ports.session.list!(),
                  resume: async (candidate: import('@volund/ui').SessionCandidate) =>
                    mapResumed(await ports.session.resumeInteractive!(candidate.id)),
                },
                // §22 W-01：web 驱动 start/resume → controller 激活 → TUI 跟随换绑。
                ...(ports.session.onActivate
                  ? {
                      sessionActivation: {
                        subscribe: (
                          listener: (
                            session: import('@volund/ui').ResumedInteractiveSession,
                          ) => void,
                        ) => ports.session!.onActivate!((session) => listener(mapResumed(session))),
                      },
                    }
                  : {}),
              }
            })()
          : {}),
        sessionId: interactive.id,
        status: 'ready',
        welcome,
        ...(ports.remoteControl?.onState
          ? {
              remoteStatus: {
                subscribe: (
                  listener: (status: {
                    state: 'off' | 'connecting' | 'online'
                    gatewayUrl: string | undefined
                  }) => void,
                ) => ports.remoteControl!.onState!(listener),
              },
            }
          : {}),
        statusPanel: resolvedStatusPanel ?? statusPanelFromWelcome(welcome),
        ...(ports.config.updatePreference
          ? {
              statusPanelController: {
                update: (id: string, value: import('@volund/ui').StatusValue) =>
                  ports.config.updatePreference!(id, value, { cwd, sessionId: interactive.id }),
                // /status 打开时刷新：Usage/Stats 显示打开时刻的用量而不是启动快照。
                ...(ports.config.status
                  ? {
                      refresh: () =>
                        ports.config.status!({
                          cwd,
                          sessionId: interactive.id,
                          includeStats: true,
                        }),
                    }
                  : {}),
              },
            }
          : {}),
      })
      await app.waitUntilExit()
      // 交互会话结束：收起插件宿主 / MCP 等 ref 住事件循环的长驻资源，否则进程
      // 悬挂不退。有界等待——超出预算的残留由 bin.ts 的显式 process.exit 兜底。
      if (ports.shutdown) {
        const budget = new Promise<'timeout'>((resolve) => {
          const timer = setTimeout(() => resolve('timeout'), 2_000)
          // unref：shutdown 先完成时这个计时器不能反过来拖住进程。
          timer.unref()
        })
        await Promise.race([
          ports.shutdown().then(
            () => undefined,
            () => undefined,
          ),
          budget,
        ])
      }
      // W-01：嵌入式 Web 控制台随 TUI 退出关闭（同样在界内等待，不拖进程）。
      await webConsole?.close().catch(() => {})
      return { exitCode: interactive.exitCode(), stdout, stderr }
    }
    const session = await ports.session.startSession({
      cwd,
      ...(prompt === undefined ? {} : { prompt }),
    })
    return { exitCode: session.exitCode ?? 0, stdout, stderr }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (jsonMode) {
      return jsonFailure(message, 1, 'internal_error')
    }
    return { exitCode: 1, stdout, stderr: message }
  }
}

function renderTextStatus(data: StatusPanelData) {
  return `${data.status.map((row) => `${row.label}: ${row.value}`).join('\n')}\n`
}

function welcomeSandboxFrom(probe: SandboxDisclosure): WelcomeSandboxStatus {
  return {
    status: 'available',
    tier: probe.tier,
    mechanism: probe.mechanism,
    filesystem: probe.features.filesystem ? 'isolated' : 'unknown',
    network: probe.features.network ? 'available' : 'unavailable',
  }
}

async function buildWelcomePanelData(input: {
  cwd: string
  dangerousPermissions: boolean
  permissionMode: 'ask' | 'auto' | 'full'
  ports: VolundPorts
  sandbox: WelcomeSandboxStatus
  sessionId: string
  trustLabel: string
  /** §22 W-01：嵌入式 Web 控制台地址（含 bearer token），存在即上欢迎屏。 */
  webUrl?: string
  /** REM-r1：远程控制 uplink 启动快照（online 后的刷新走 remoteStatus 订阅回填）。 */
  remote?: WelcomePanelData['remote']
  model?: WelcomeModelStatus & { status: 'available' }
}): Promise<WelcomePanelData> {
  const config = await welcomeConfig(input.ports, input.cwd)
  const mcp = await welcomeMcp(input.ports)
  const native = welcomeNativeFrom(input.ports)
  return {
    version: input.ports.identity.version,
    sessionId: input.sessionId,
    trustLabel: input.trustLabel,
    cwd: input.cwd,
    ...(input.webUrl ? { web: { url: input.webUrl } } : {}),
    ...(input.remote ? { remote: input.remote } : {}),
    model: input.model ?? {
      status: 'available',
      provider: 'anthropic',
      model: defaultInteractiveModel.split('/').slice(1).join('/'),
      source: 'default',
    },
    sandbox: input.sandbox,
    ...(native ? { native } : {}),
    permission: {
      mode: input.permissionMode,
      dangerous: input.dangerousPermissions,
      source: input.dangerousPermissions ? 'flag' : 'default',
    },
    config,
    mcp,
    history: {
      status: 'available',
      path: 'volund input history',
      entries: 0,
      maxEntries: 1000,
    },
  }
}

/** 探针快照 → 欢迎屏三态；端口未接或仍在 probing 时保持 probing 不谎报。 */
function welcomeNativeFrom(ports: VolundPorts): WelcomeNativeStatus | undefined {
  const available = ports.native.available?.()
  if (!available) return undefined
  const status = (value: boolean | 'probing'): NativeModuleStatus =>
    value === 'probing' ? 'probing' : value ? 'loaded' : 'unavailable'
  return {
    sandbox: status(available.sandbox),
    search: status(available.search),
    fs: status(available.fs),
  }
}

function buildModelPicker(
  currentModelId: string,
  configuredModel?: string,
  aliases: Record<string, { provider: string; model: string }> = {},
) {
  const builtins = [
    {
      id: 'anthropic/claude-sonnet-4-20250514',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      label: 'Claude Sonnet 4',
      description: 'Current default coding model',
    },
    {
      id: 'anthropic/claude-opus-4-20250514',
      provider: 'anthropic',
      model: 'claude-opus-4-20250514',
      label: 'Claude Opus 4',
      description: 'Unavailable until enabled in router config',
      disabled: true,
    },
  ]
  // 生效模型（配置值或 resume 恢复的会话钉住值）prepend 进候选，让用户在 picker
  // 里能切回；与内置候选同 id 时不重复插入。provider/model 从 id 自身解析（id 即
  // 显式模型 id 形 provider/<model>，model 段可含网关路径，如 anthropic/weibo/glm-5.2）。
  const bare = currentModelId.includes('/')
    ? currentModelId.split('/').slice(1).join('/')
    : currentModelId
  const provider = currentModelId.includes('/') ? currentModelId.split('/')[0]! : 'anthropic'
  const extra = !builtins.some((item) => item.id === currentModelId)
    ? [
        {
          id: currentModelId,
          provider,
          model: bare,
          label: bare,
          description: configuredModel
            ? 'Configured via provider.anthropic.model'
            : 'Session model (restored on resume)',
        },
      ]
    : []
  // [models.aliases]（§8.3）：别名进 picker（⭐ 无关，label 即别名），id 用解析后
  // 的 provider/model——选中走 /model 同一条显式模型覆盖通道。
  const aliasEntries = Object.entries(aliases)
    .filter(([, value]) => value.provider === 'anthropic')
    .map(([alias, value]) => ({
      id: `${value.provider}/${value.model}`,
      provider: value.provider,
      model: value.model,
      label: alias,
      description: `Alias → ${value.model}`,
    }))
    .filter((entry) => !builtins.some((item) => item.id === entry.id))
  return { currentModelId, models: [...extra, ...builtins, ...aliasEntries] }
}

async function welcomeConfig(ports: VolundPorts, cwd: string): Promise<WelcomePanelData['config']> {
  try {
    const health = await ports.config.health(cwd)
    if (health.valid === false)
      return {
        effectiveSources: ['defaults'],
        user: {
          status: 'unavailable',
          reason: { code: 'config_invalid', message: health.detail },
        },
        project: {
          status: 'blocked',
          path: `${cwd}/.volund/config.toml`,
          trusted: false,
          reason: { code: 'config_invalid', message: health.detail },
        },
      }
    return {
      effectiveSources: ['defaults', 'user'],
      user: { status: 'available', path: 'user config', trusted: true },
      project: { status: 'disabled' },
    }
  } catch (error) {
    return {
      effectiveSources: ['defaults'],
      user: {
        status: 'unavailable',
        reason: {
          code: 'config_unavailable',
          message: error instanceof Error ? error.message : String(error),
        },
      },
      project: { status: 'disabled' },
    }
  }
}

async function welcomeMcp(ports: VolundPorts): Promise<WelcomePanelData['mcp']> {
  if (!ports.mcp)
    return {
      status: 'unavailable',
      reason: { code: 'mcp_port_unavailable', message: 'MCP integration port is not connected' },
    }
  try {
    const servers = await ports.mcp.list()
    return {
      status: 'available',
      connected: servers.length,
      total: servers.length,
      servers: servers.map((server) => ({ name: server.name, status: 'connected' })),
    }
  } catch (error) {
    return {
      status: 'unavailable',
      reason: {
        code: 'mcp_list_failed',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function jsonFailure(
  message: string,
  exitCode: number,
  code: string,
  category = 'runtime',
): CliResult {
  const timestamp = new Date().toISOString()
  const data = sanitize({ code, category, retryable: false, exitCode, message })
  const error = { v: 1, type: 'error', seq: 1, sessionId: '', timestamp, data }
  const final = {
    v: 1,
    type: 'final',
    seq: 2,
    sessionId: '',
    timestamp,
    data: { status: 'error', exitCode },
  }
  return { exitCode, stdout: `${JSON.stringify(error)}\n${JSON.stringify(final)}\n`, stderr: '' }
}
/**
 * SKILLS-MCPS-r1 §S3.7：`volund mcp add` 的手动解析（citty 不支持 `--` 透传与
 * 重复 flag）。形态（业界惯例）：
 *   volund mcp add [-s user|project] [-e K=V]... <name> -- <command> [args...]
 *   volund mcp add [-t http|sse] [-s scope] [-H 'K: v']... <name> <url>
 */
export function parseMcpAddArgs(tokens: readonly string[]): {
  input?: import('./ports').McpAddInput
  error?: string
} {
  const env: Record<string, string> = {}
  const headers: Record<string, string> = {}
  let scope: 'user' | 'project' = 'user'
  let transportKind: 'stdio' | 'http' | 'sse' | undefined
  const positionals: string[] = []
  let command: string[] | undefined
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === '--') {
      command = tokens.slice(index + 1)
      break
    }
    if (token === '-t' || token === '--transport') {
      const value = tokens[++index]
      if (value !== 'http' && value !== 'sse' && value !== 'stdio')
        return { error: `--transport must be http, sse, or stdio (got ${value})` }
      transportKind = value
      continue
    }
    if (token === '-s' || token === '--scope') {
      const value = tokens[++index]
      if (value !== 'user' && value !== 'project')
        return { error: `--scope must be user or project (got ${value})` }
      scope = value
      continue
    }
    if (token === '-e' || token === '--env') {
      const pair = tokens[++index]
      const split = pair?.indexOf('=')
      if (pair === undefined || split === undefined || split <= 0)
        return { error: `--env expects KEY=VALUE (got ${pair})` }
      env[pair.slice(0, split)] = pair.slice(split + 1)
      continue
    }
    if (token === '-H' || token === '--header') {
      const pair = tokens[++index]
      const split = pair ? Math.max(pair.indexOf(':'), pair.indexOf('=')) : -1
      if (pair === undefined || split <= 0)
        return { error: `--header expects 'Key: value' (got ${pair})` }
      headers[pair.slice(0, split).trim()] = pair.slice(split + 1).trim()
      continue
    }
    if (token.startsWith('-') && token.length > 1)
      return { error: `Unknown flag for mcp add: ${token}` }
    positionals.push(token)
  }
  const name = positionals[0]
  if (!name) return { error: 'mcp add requires a server name' }
  const url = positionals[1]
  if (command && command.length > 0) {
    if (url) return { error: 'mcp add takes either <url> or `-- <command> [args...]`, not both' }
    if (transportKind === 'http' || transportKind === 'sse')
      return { error: '--transport http/sse expects <url>, not a stdio command' }
    return {
      input: {
        name,
        scope,
        transport: { kind: 'stdio', command: command[0]!, args: command.slice(1), env },
      },
    }
  }
  if (url && /^https?:\/\//.test(url))
    return {
      input: {
        name,
        scope,
        transport: { kind: 'http', url, headers, legacySse: transportKind === 'sse' },
      },
    }
  if (url) return { error: `Not a URL and no stdio command given: ${url} (use \`-- <command>\`)` }
  return { error: 'mcp add requires a transport: `-- <command> [args...]` (stdio) or <url> (http)' }
}
function redactTransport(value: string): string {
  try {
    const url = new URL(value)
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
    }
    return url.toString()
  } catch {
    return value.replace(/(authorization|token|secret|key)=\S+/gi, '$1=<hidden>')
  }
}

const chatGlobalFlags = new Set([
  '--cwd',
  '--json',
  // W-17 任务约束（headless 会话启动注入；F1-02 execution surface）
  '--model',
  '--budget',
  '--allowed-tools',
  '--no-color',
  '--no-tui',
  '--strict-sandbox',
  '--dangerous-no-sandbox',
  '--dangerously-skip-permissions',
  '--permission-mode',
  '--trust-workspace',
  '--yolo',
])
const reservedCommandNames: ReadonlySet<string> = new Set(Object.keys(commandUsage))
const valueFlags = new Set([
  '--cwd',
  '--namespace',
  '--since',
  '--to',
  '--model',
  '--budget',
  '--allowed-tools',
])

/** value flag（空格赋值形态）的值不算位置参数——与 firstUnsupportedGlobalFlag 同口径。 */
function firstNonFlagTokenIndex(tokens: string[]): number {
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token?.startsWith('-')) return i
    const flag = token.split('=')[0]!
    if (valueFlags.has(flag) && !token.includes('=')) i++
  }
  return -1
}

/** argsDefinition 里全部声明为 string 的旗标（kebab 形态）——空格赋值时其值被 citty 消费。 */
const declaredValueFlags = new Set(
  Object.entries(argsDefinition)
    .filter(([, def]) => def.type === 'string')
    .map(([name]) => `--${name.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`)}`),
)

/**
 * 归一 token 里的双横线旗标名为声明形态（kebab → camel、--no-x → x），供未知
 * 旗标校验比对。单横线短旗标不校验（现有短路旗标 -v/-h 已另行处理）。
 */
function normalizeFlagToken(token: string): string | undefined {
  if (!token.startsWith('--')) return undefined
  const camel = token
    .slice(2)
    .split('=', 1)[0]!
    .replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())
  return camel.length > 0 ? camel : undefined
}

/** 全部声明旗标（camelCase）——未知旗标校验的白名单。 */
const declaredFlags = new Set(Object.keys(argsDefinition))

/**
 * 第 n 个（从 1 起）位置参数在 tokens 里的下标；与 citty 的 value-flag 值消费
 * 同口径（声明为 string 的旗标吃掉下一个 token）。用于把 args._[k] 映射回
 * raw token 下标——比如 `volund mcp add` 的 'add' 定位不能靠字面量搜索，
 * 否则 `--model add mcp add …` 这类旗标值恰好等于动作名的输入会错切。
 */
function nthPositionalIndex(tokens: readonly string[], n: number): number {
  let seen = 0
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]
    if (!token?.startsWith('-')) {
      seen += 1
      if (seen === n) return i
      continue
    }
    const flag = token.split('=')[0]!
    if (declaredValueFlags.has(flag) && !token.includes('=')) i += 1
  }
  return -1
}

function firstUnsupportedGlobalFlag(rawArgs: string[]): string | undefined {
  for (let i = 0; i < rawArgs.length; i++) {
    const token = rawArgs[i]
    if (!token?.startsWith('-')) continue
    const flag = token.split('=')[0]!
    if (!chatGlobalFlags.has(flag)) return flag
    if (valueFlags.has(flag) && !token.includes('=')) i++
  }
  return undefined
}
