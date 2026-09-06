# Install

## Standalone installer (macOS / Linux)

Once the first standalone release is published, install the prebuilt `volund` binary with:

```sh
curl -fsSL https://raw.githubusercontent.com/JS-mark/volund-code/main/scripts/install/install.sh | bash
```

The script maps the host to a release target (darwin/linux × arm64/x64 × gnu/musl), downloads `volund-standalone-<target>.tar.gz` from the matching GitHub Release, verifies its SHA-256 against `release-manifest.json`, and installs into `~/.volund` (native sidecars and bundled plugins stay next to the executable, which is what standalone artifact resolution expects). `~/.volund/bin` is added to your PATH automatically.

Install a pinned version with `VOLUND_INSTALL_VERSION=v0.1.0` or the first argument (`bash -s -- v0.1.0`). Re-running the installer upgrades in place; `rm -rf ~/.volund` uninstalls. Windows is served through the npm packages below or WSL.

## Build from source

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
