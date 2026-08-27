import type { VolundPorts } from '../ports'

export interface CliResult {
  exitCode: number
  stderr: string
  stdout: string
}

export interface CliIo {
  isInteractiveTerminal?(): boolean
  readStdin(): Promise<string>
  confirm?(message: string): Promise<boolean>
}

export interface ParsedCliArgs {
  _: string[]
  all?: boolean
  cwd?: string
  json?: boolean
  strict?: boolean
  [key: string]: unknown
}

export interface CommandContext {
  args: ParsedCliArgs
  cwd: string
  ports: VolundPorts
}

export interface CommandDefinition {
  name: string
  run(context: CommandContext): Promise<CliResult>
}
