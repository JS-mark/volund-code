/**
 * NativeController 域（§5.8 / P1-04e）：native 探针的三态可用性、启动点火、
 * probe 披露与健康检查。从 createProductionPorts 迁入；行为等价。
 */
import { nativeProbes, probeSandbox, resolveBinary } from '@volund/native-bridge'

export interface NativeDomainOptions {
  readonly version: string
  readonly emitTelemetry: (
    name: string,
    category: string,
    payload: Record<string, unknown>,
  ) => Promise<unknown> | void
}

export function createNativeDomain(options: NativeDomainOptions) {
  return {
    /** Tri-state availability snapshot (r13-P1): 'probing' until backfill. */
    available() {
      const availability = nativeProbes.available
      return {
        sandbox: availability.sandbox,
        search: availability.search,
        fs: availability.fs,
      }
    },
    /**
     * r13-P1 startup contract (spec 05-rust-sidecar.md §5.8): fires every
     * native probe (sandbox --probe + search/fs worker handshakes) in
     * parallel. The REPL never awaits them — `available.*` starts as
     * 'probing' and backfills asynchronously; side-effect waits are
     * budget-bounded instead.
     */
    startProbes() {
      nativeProbes.start()
    },
    /** Resolves when every probe settled or its budget expired (probe.ts contract). */
    settled() {
      return nativeProbes.settled()
    },
    async probe() {
      const info = await probeSandbox()
      const features = info.features as Record<string, unknown>
      const mechanism =
        typeof features.mechanism === 'string' ? features.mechanism : 'volund-sandbox'
      const abi = typeof features.abi === 'string' ? features.abi : 'unknown'
      const disclosure = {
        tier: info.tier,
        mechanism,
        features: {
          filesystem: Boolean(features.filesystem ?? info.tier !== 'none'),
          network: Boolean(features.network),
        },
        degradationReasons: info.known_limitations,
      }
      await options.emitTelemetry('sandbox.probe', 'sandbox', {
        tier: disclosure.tier,
        mechanism: disclosure.mechanism,
        abi,
        version: options.version,
        probedAt: new Date().toISOString(),
      })
      return disclosure
    },
    async health() {
      const [probe, search, fs] = await Promise.all([
        probeSandbox(),
        resolveBinary('search'),
        resolveBinary('fs'),
      ])
      return { sandbox: probe.tier !== 'none', search: search !== null, fs: fs !== null }
    },
  }
}
