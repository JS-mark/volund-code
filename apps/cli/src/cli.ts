import { dirname } from 'node:path'
import { createInterface } from 'node:readline/promises'

import { ErrorCodes, sanitize, validateWorkspacePath } from '@apollo-code/shared'
import {
  PermissionPromptController,
  renderPrivacyDisclosure,
  renderSandboxDisclosure,
  renderSecurityBanner,
  statusPanelFromWelcome,
} from '@apollo-code/ui'
import type {
  DangerousMode,
  SandboxDisclosure,
  StatusPanelData,
  WelcomeModelStatus,
  WelcomePanelData,
  WelcomeSandboxStatus,
} from '@apollo-code/ui'
import { parseArgs, renderUsage } from 'citty'

import { CommandRegistry } from './app/command-registry'
import { createCommand } from './command'
import { doctorCommand } from './commands/doctor'
import { createMemoryCommand, memoryUsage } from './commands/memory'
import { createStatusCommand } from './commands/status'
import { telemetryCommand } from './commands/telemetry'
import { trustCommand } from './commands/trust'
import { createMemoryPanelController } from './memory-panel'
import { projectMemoryScope } from './memory-scope'
import type { ApolloPorts } from './ports'
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
  ports: ApolloPorts,
  io: CliIo = defaultIo,
): Promise<CliResult> {
  const command = createCommand(ports.identity)
  if (
    rawArgs[0] === 'memory' &&
    (rawArgs[1] === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h'))
  )
    return { exitCode: 0, stdout: memoryUsage, stderr: '' }
  if (rawArgs[0] === 'help' || rawArgs.includes('--help') || rawArgs.includes('-h'))
    return { exitCode: 0, stdout: await renderUsage(command), stderr: '' }
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
    createStatusCommand({
      buildFallback: async (fallbackCwd) =>
        buildWelcomePanelData({
          cwd: fallbackCwd,
          dangerousPermissions: false,
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
    return { exitCode: 0, stdout: `${stdout}${await renderUsage(command)}`, stderr }
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
        : `${servers.map((server) => `${server.name}\t${redactTransport(server.transport)}`).join('\n')}${servers.length ? '\n' : ''}`
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
    return { exitCode: 2, stdout, stderr: `Unknown mcp action: ${action}` }
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
        onExit: interactive.end,
        ...(interactive.interrupt
          ? { onInterrupt: () => interactive.interrupt!() }
          : {}),
        onSubmit: interactive.submit,
        modelPicker: buildModelPicker(effectiveModelId, configuredModel),
        permissions,
        sandboxProbe: () =>
          probePromise.then((probe) => ({
            sandbox: welcomeSandboxFrom(probe),
            status: statusText(probe.tier),
          })),
        ...(ports.session.list && ports.session.resumeInteractive
          ? {
              resume: {
                list: () => ports.session.list!(),
                resume: async (candidate: import('@apollo-code/ui').SessionCandidate) => {
                  const resumed = await ports.session.resumeInteractive!(candidate.id)
                  return {
                    cwd: resumed.cwd ?? candidate.cwd,
                    events: resumed.events,
                    id: resumed.id,
                    onExit: resumed.end,
                    ...(resumed.interrupt
                      ? { onInterrupt: () => resumed.interrupt!() }
                      : {}),
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
                update: (id: string, value: import('@apollo-code/ui').StatusValue) =>
                  ports.config.updatePreference!(id, value, { cwd, sessionId: interactive.id }),
              },
            }
          : {}),
      })
      await app.waitUntilExit()
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
  ports: ApolloPorts
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
    permission: {
      mode: input.dangerousPermissions ? 'bypassed' : 'ask',
      dangerous: input.dangerousPermissions,
      source: input.dangerousPermissions ? 'flag' : 'default',
    },
    config,
    mcp,
    history: {
      status: 'available',
      path: 'apollo input history',
      entries: 0,
      maxEntries: 1000,
    },
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

async function welcomeConfig(ports: ApolloPorts, cwd: string): Promise<WelcomePanelData['config']> {
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
          path: `${cwd}/.apollo/config.toml`,
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

async function welcomeMcp(ports: ApolloPorts): Promise<WelcomePanelData['mcp']> {
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
