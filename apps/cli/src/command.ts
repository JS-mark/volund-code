import { defineCommand, renderUsage } from 'citty'
import type { ArgsDef, CommandDef } from 'citty'

import type { AppIdentity } from './shared/app-identity'

const leaf = (name: string, description: string) => defineCommand({ meta: { name, description } })
export const createCommand = (identity: AppIdentity) =>
  defineCommand({
    meta: {
      name: 'apollo',
      version: identity.version,
      description: 'Open, model-agnostic AI coding CLI',
    },
    subCommands: {
      chat: leaf('chat', 'Start an interactive chat'),
      resume: leaf('resume', 'Resume a saved session'),
      restore: leaf('restore', 'Restore files changed by a saved session'),
      login: leaf('login', 'Configure provider credentials'),
      logout: leaf('logout', 'Remove provider credentials'),
      config: leaf('config', 'Inspect configuration'),
      status: leaf('status', 'Show redacted runtime and configuration status'),
      history: leaf('history', 'List or show sessions'),
      context: leaf('context', 'Inspect and control context compaction'),
      evolution: leaf('evolution', 'Inspect and rollback local tuning'),
      plugin: leaf('plugin', 'Install and manage sandboxed plugins'),
      telemetry: leaf('telemetry', 'Inspect, export, or clear local telemetry'),
      trust: leaf('trust', 'List or revoke trusted directories'),
      doctor: leaf('doctor', 'Diagnose L1 dependencies'),
      memory: leaf('memory', 'Manage, search, and maintain durable memory'),
      hook: leaf('hook', 'List builtin hooks'),
      skill: leaf('skill', 'Install, manage, and show prompt skills'),
      mcp: leaf('mcp', 'Add, list, test, enable/disable, and inspect MCP servers'),
      version: leaf('version', 'Print version'),
      help: leaf('help', 'Show command help'),
    },
  })

/** Stable test fixture; production uses createCommand(appIdentity). */
export const command = createCommand({ version: '0.0.0-test' })

/**
 * citty enumerates every subcommand inline in the USAGE line
 * (`USAGE apollo chat|resume|...`); the COMMANDS table below it already lists
 * them, so collapse the enumeration to `<command>`.
 */
export async function renderGlobalUsage(cmd: CommandDef<ArgsDef>): Promise<string> {
  const rendered = await renderUsage(cmd)
  return rendered.replace(/(USAGE[^\n]*?apollo) [\w|-]+/, '$1 <command>')
}
