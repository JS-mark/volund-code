# Standalone binary and native asset resolver

Status: accepted prototype for APO-59. Real publishing, signing, notarization, and channel distribution remain unperformed and require release authorization.

## Decision

Use `bun build --compile` for the eight target-specific Volund launchers. Reject `pkg`: it embeds an end-of-life Node snapshot model, adds a second module/asset virtualization layer, and is a poor fit for the ESM application and externally executed Rust workers. Bun is still gated per target by the same CLI integration suite; this RFC does not claim cross-built artifacts were executed.

Each archive contains the launcher plus a `native/` directory with `manifest.json` and exactly the current target's `volund-sandbox`, `volund-search`, and `volund-fs` executables. The plugin host remains an input JS ESM bundle executed only through `volund-sandbox --run-plugin`; it is not a fourth privileged binary and is never run in-process. The manifest is schema-versioned and pins kind, target, filename, and SHA-256. The outer archive additionally ships `checksums.sha256`, CycloneDX SBOM, `LICENSE`, and `NOTICE`.

The resolver order is explicit override → verified bundled asset → verified version cache → exact-version GitHub Release download → unavailable safe fallback. A bundled checksum mismatch is fatal and never falls through to the network. Unsupported OS/architecture, missing asset, and wrong target are distinguishable in `resolveBinaryDetailed`; sandbox/plugin execution continues to fail closed, while search/fs retain their existing JS fallback. Paths with spaces are passed as argv, never through a shell.

## Extraction, cache, and cleanup

Bun's executable is not treated as a writable filesystem. Release assembly places native assets beside the launcher; packaged resources may be copied on first run to a per-version/per-target cache only after digest verification, using a same-directory temporary file and atomic rename. `VOLUND_STANDALONE_ASSET_DIR` supports immutable/read-only installations and test fixtures. `VOLUND_NATIVE_CACHE_DIR` supports managed or temporary caches. Stale versions may be removed explicitly by a future maintenance command; the resolver never recursively deletes an unvalidated root and only removes its own failed temporary/download target.

Offline use succeeds from the bundled directory or a pre-seeded verified cache. Network failure returns unavailable rather than running an unverified file. `doctor --strict --json` is the audit surface: it reports each native capability independently and exits non-zero when any required native asset is unavailable; management JSON remains a single document and never mixes TUI output.

## Release gates

For every one of darwin arm64/x64, Linux glibc arm64/x64, Linux musl arm64/x64, and Windows MSVC arm64/x64: build the three Rust workers; verify native licenses and bundled-bwrap digest; generate manifest, SBOM, NOTICE and SHA-256 files; compile the launcher; run tamper/missing/wrong-platform and read-only/temp/cache tests; then run `volund doctor --strict --json` and a no-Node smoke in an environment whose PATH has no node/npm/pnpm. Native-host results must be labeled executed; QEMU/cross results must be labeled cross/partial. Signing, notarization, hardware validation, and publication are separate release gates and may never be inferred from a successful build.
