# Install

Volund CLI requires Node.js 20.19 or newer. The stable npm release is not published yet; until release approval, build from the repository:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/volund.js --help
```

The source bundle keeps the legacy `dist/volund.js` filename during the compatibility window. Published packages expose `volund` as the canonical executable and retain `volund` as an alias.

The canonical npm package is `@volund/cli`; platform artifacts use the `@volund/*` scope. The legacy `volund-code` package is generated only as a compatibility meta package. Registry ownership and the first public version still require release approval.

Do not treat the draft `0.0.0` workspace version as a released package. Official install instructions will name the first published version and tag after human approval.

The JavaScript package does not bundle every native target. On first use, Volund downloads the exact-version `sandbox`, `search`, and `fs` binaries from the matching GitHub Release, verifies them against `checksums.sha256`, and caches them under the version and target triple. It never resolves native binaries from a moving `latest` release.
