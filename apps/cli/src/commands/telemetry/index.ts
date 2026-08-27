import { renderTelemetryPanel } from '@volund/ui'

import type { CommandDefinition } from '../../shared/cli-types'

export const telemetryCommand: CommandDefinition = {
  name: 'telemetry',
  async run({ args, ports }) {
    const action = args._[1] ?? 'show'
    if (action === 'show') {
      const summary = await ports.telemetry.summary()
      return {
        exitCode: 0,
        stdout: `${args.json ? JSON.stringify(summary) : renderTelemetryPanel(summary)}\n`,
        stderr: '',
      }
    }
    if (action === 'export') {
      const target = args._[2]
      if (!target)
        return { exitCode: 2, stdout: '', stderr: 'telemetry export requires a target path' }
      const count = await ports.telemetry.export(target)
      return { exitCode: 0, stdout: `Exported ${count} redacted event(s).\n`, stderr: '' }
    }
    if (action === 'clear') {
      await ports.telemetry.clear()
      return { exitCode: 0, stdout: 'Cleared local telemetry.\n', stderr: '' }
    }
    return { exitCode: 2, stdout: '', stderr: `Unknown telemetry action: ${action}` }
  },
}
