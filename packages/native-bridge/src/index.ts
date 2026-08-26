import { nativeProbes } from './probe'
import { probeSandbox } from './sandbox'
import { workerPool } from './worker-pool'

// r13-P1: wire the process-wide probe coordinator. Registration captures the
// probe functions only; nothing spawns until `nativeProbes.start()` (called by
// the composition root) or a first lazy availability read.
nativeProbes.registerSources({
  sandbox: probeSandbox,
  worker: async (kind) => {
    try {
      return (await workerPool.ensureWorker(kind)) !== null
    } catch {
      return false
    }
  },
})

export { resolveBinary, resolveBinaryDetailed, standaloneArtifactDir } from './resolver'
export type { BinaryKind, NativeResolution } from './resolver'
export { execSandbox, probeSandbox, startPluginHost } from './sandbox'
export { computeDiff, countTokens, readLarge } from './fs'
export { NativeProbeCoordinator, nativeProbes } from './probe'
export type { NativeAvailability, NativeProbeSources, ProbeAvailability, ProbeKind } from './probe'
export { astQuery, search } from './search'
export { WorkerPool, workerPool } from './worker-pool'
export type { AstMatch, AstQueryOptions, SearchMatch, SearchOptions } from './search'
export type {
  ExecOptions,
  ExecResult,
  PluginHost,
  PluginHostOptions,
  PluginSandboxProfile,
  SandboxInfo,
  SandboxTier,
} from './types'
