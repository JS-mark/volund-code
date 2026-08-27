import { productIdentity } from '@volund/shared'

import { buildIdentity } from './build-identity'

export interface AppIdentity {
  version: string
  commit?: string
  channel?: string
  builtAt?: string
}

const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

export function defineAppIdentity(input: AppIdentity): Readonly<AppIdentity> {
  if (!semverPattern.test(input.version))
    throw new Error(`Invalid ${productIdentity.shortName} version: ${input.version}`)
  if (input.version === '0.0.0')
    throw new Error(`${productIdentity.shortName} production identity cannot use 0.0.0`)
  return Object.freeze({ ...input })
}

export const appIdentity = defineAppIdentity(buildIdentity)
