import { basename, dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { ErrorCodes, productIdentity, sanitize, validateWorkspacePath } from '@volund/shared'
import {
  PermissionPromptController,
  renderPrivacyDisclosure,
  renderSandboxDisclosure,
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
import { createStatusCommand } from './commands/status'
import { telemetryCommand } from './commands/telemetry'
import { trustCommand } from './commands/trust'
import { createMemoryPanelController } from './memory-panel'
import { projectMemoryScope } from './memory-scope'
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
  id: { type: 'string' as const },
  content: { type: 'string' as const },
  bodyStdin: { type: 'boolean' as const },
  expectedUpdatedAt: { type: 'string' as const },
  strategy: { type: 'string' as const },
  yes: { type: 'boolean' as const },
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
    if (topic === undefined)
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
  if (rawArgs[0] === 'version' || rawArgs.includes('--version') || rawArgs.includes('-v'))
    return { exitCode: 0, stdout: `${ports.identity.version}\n`, stderr: '' }
  const args = parseArgs(rawArgs, argsDefinition) as ParsedCliArgs
  const subcommand = args._[0]
  let stdout = ''
  let stderr = ''
  const jsonMode = Boolean(args.json)
  const noColor = Boolean(args.noColor) || (args as { color?: boolean }).color === false
  const noTui = Boolean(args.noTui) || (args as { tui?: boolean }).tui === false
  let resumeSelection: { id: string; cwd: string } | undefined
  const unsupportedGlobalFlag =
    subcommand === undefined ? firstUnsupportedGlobalFlag(rawArgs) : undefined
  if (unsupportedGlobalFlag) {
    const message = `Unsupported global flag without a command: ${unsupportedGlobalFlag}`
    return jsonMode
      ? jsonFailure(message, 2, 'unsupported_flag', 'usage')
      : { exitCode: 2, stdout, stderr: message }
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
  ])
  if (subcommand && registry.has(subcommand))
    return registry.dispatch(subcommand, { args, cwd, ports })
  if (subcommand === 'version')
    return { exitCode: 0, stdout: `${stdout}${ports.identity.version}\n`, stderr }
  if (subcommand === 'help')
    return { exitCode: 0, stdout: `${stdout}${await renderGlobalUsage(command)}`, stderr }
  if (subcommand === 'hook' && args._[1] === 'list')
    return { exitCode: 0, stdout: `${stdout}No builtin hooks registered.\n`, stderr }
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
      const parsed = parseMcpAddArgs(rawArgs.slice(rawArgs.indexOf('add') + 1))
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
    if (!jsonMode) {
      stdout += `${renderPrivacyDisclosure()}\n`
      stdout += `${renderSandboxDisclosure(probe)}\n`
    }
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
  {
    const flagMode =
      args.permissionMode === 'ask' ||
      args.permissionMode === 'auto' ||
      args.permissionMode === 'full'
        ? args.permissionMode
        : undefined
    if (args.permissionMode !== undefined && flagMode === undefined)
      throw new Error(
        `invalid --permission-mode '${String(args.permissionMode)}' (ask | auto | full)`,
      )
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
        : await ports.session.startInteractive!({ cwd })
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
      const permissions = new PermissionPromptController()
      if (!(args.yolo || args.dangerouslySkipPermissions))
        interactive.setPermissionPromptHandler?.((request) => permissions.request(request))
      const permissionsBypassed = Boolean(args.yolo || args.dangerouslySkipPermissions)
      const statusText = (tier: string) =>
        `sandbox ${tier}${permissionsBypassed ? '; permissions bypassed' : ''}`
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
      const effectiveModelId = configuredModel
        ? configuredModel.startsWith('anthropic/')
          ? configuredModel
          : `anthropic/${configuredModel}`
        : defaultInteractiveModel
      const welcome = await buildWelcomePanelData({
        cwd,
        dangerousPermissions: permissionsBypassed,
        permissionMode: ports.permissionMode?.current() ?? (permissionsBypassed ? 'full' : 'ask'),
        ports,
        sandbox: { status: 'probing' },
        sessionId: interactive.id,
        trustLabel,
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
        onSubmit: interactive.submit,
        modelPicker: buildModelPicker(effectiveModelId, configuredModel),
        permissions,
        // 沙箱探针 + search/fs worker 探针并行跑；等全部 settle（预算封顶 5s）
        // 一次性回填，避免欢迎屏 native 状态停在 probing 或闪烁两跳。
        sandboxProbe: () =>
          Promise.all([probePromise, ports.native.settled?.() ?? Promise.resolve()]).then(
            ([probe]) => ({
              sandbox: welcomeSandboxFrom(probe),
              native: welcomeNativeFrom(ports),
              status: statusText(probe.tier),
            }),
          ),
        ...(ports.session.list && ports.session.resumeInteractive
          ? {
              resume: {
                list: () => ports.session.list!(),
                resume: async (candidate: import('@volund/ui').SessionCandidate) => {
                  const resumed = await ports.session.resumeInteractive!(candidate.id)
                  return {
                    cwd: resumed.cwd ?? candidate.cwd,
                    events: resumed.events,
                    id: resumed.id,
                    onExit: resumed.end,
                    ...(resumed.interrupt ? { onInterrupt: () => resumed.interrupt!() } : {}),
                    onSubmit: resumed.submit,
                    ...(resumed.transcript ? { transcript: resumed.transcript } : {}),
                  }
                },
              },
            }
          : {}),
        sessionId: interactive.id,
        status: statusText('probing'),
        welcome,
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
      return { exitCode: interactive.exitCode(), stdout, stderr }
    }
    const session = await ports.session.start({ cwd, ...(prompt === undefined ? {} : { prompt }) })
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
  model?: WelcomeModelStatus & { status: 'available' }
}): Promise<WelcomePanelData> {
  const config = await welcomeConfig(input.ports, input.cwd)
  const mcp = await welcomeMcp(input.ports)
  return {
    version: input.ports.identity.version,
    sessionId: input.sessionId,
    trustLabel: input.trustLabel,
    cwd: input.cwd,
    model: input.model ?? {
      status: 'available',
      provider: 'anthropic',
      model: defaultInteractiveModel.split('/').slice(1).join('/'),
      source: 'default',
    },
    sandbox: input.sandbox,
    native: welcomeNativeFrom(input.ports),
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

function buildModelPicker(currentModelId: string, configuredModel?: string) {
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
  // 配置生效的模型（如企业网关的 weibo/glm-5.2） prepend 进候选，
  // 让用户在 picker 里能切回配置值；与内置候选同 id 时不重复插入。
  const bare = configuredModel?.replace(/^anthropic\//, '')
  const extra =
    configuredModel && !builtins.some((item) => item.id === currentModelId)
      ? [
          {
            id: currentModelId,
            provider: 'anthropic',
            model: bare ?? configuredModel,
            label: bare ?? configuredModel,
            description: 'Configured via provider.anthropic.model',
          },
        ]
      : []
  return { currentModelId, models: [...extra, ...builtins] }
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
  '--no-color',
  '--no-tui',
  '--strict-sandbox',
  '--dangerous-no-sandbox',
  '--dangerously-skip-permissions',
  '--trust-workspace',
  '--yolo',
])
const valueFlags = new Set(['--cwd', '--namespace', '--since', '--to'])

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
