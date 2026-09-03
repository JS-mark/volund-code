---
'@volund/shared': minor
---

Centralize every cross-module error code in an `ErrorCodes` registry (`error-codes.ts`) covering
`error.raised` contract codes from appendix B.2, plugin, memory, provider/router, CLI `--json`,
transport `VOLUND_*`, and testkit domains, with `ErrorCode` typing, appendix/normalized subsets,
and a `pnpm verify:error-codes` drift check wired into the turbo `test` task so unregistered or
zombie codes fail CI.
