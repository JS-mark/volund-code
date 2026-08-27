# @volund/native-bridge

## 0.1.0

### Minor Changes

- 3f92c86: Add the plugin manifest, installation lifecycle, type-only authoring SDK, RPC guards, and the native sandbox plugin-host launch boundary.
- 5e3e011: Accept exact network allowlists in native sandbox execution profiles and add reproducible Windows/Graviton L3 evidence automation.
- 911e807: Add resolver and audited GitHub Release asset foundations for Linux musl and Windows x64/arm64 native targets.
- 5a4987c: Ship the Rolldown single-file CLI and the twelve L1 native release assets,
  with three-OS TypeScript, four-target native, escape, doctor, digest, and
  universal2 CI evidence. Linux arm64 QEMU evidence remains partial verification
  and is never presented as real-hardware validation.
- 54d0d7a: Resolve exact-version native binaries from GitHub Release assets with SHA-256 verification and a versioned local cache instead of npm platform packages.
- ec4d987: Add L1 search and filesystem workers, supervised JSON-RPC pooling, safe fallbacks, and native security CI gates.
- 4bb00af: Add the standalone binary assembly contract and verified bundled native resolver.
- 5a9f08f: Implement real native diff, model tokenization, large-file decoding, regex search, and tree-sitter AST queries with explicit JavaScript fallbacks.
- 4bdee12: Add the fail-closed L1 sandbox binary bridge, platform resolution, and frozen capability probing.

  Add pinned Codex sandbox provenance and bundled-binary SHA256 verification.

  Vendor the reviewed Codex sandbox source snapshots and compile the pinned
  closed-by-default Seatbelt base policy into the macOS backend.

- 5cc5254: Add the native sandboxed plugin-host execution protocol and bounded NDJSON bridge.
- 4842243: Upgrade Windows sandbox execution to Partial-tier AppContainer filesystem
  isolation with allowlist ACE grants, deterministic rollback, and crash-orphan
  cleanup on both x64 and arm64.
- ad4613e: Enable Windows Tier 1 command execution with a restricted token and Job Object
  resource limits, and verify the Weak-tier boundary on native x64 and arm64
  Windows runners.

### Patch Changes

- 7cbaab5: Bundle audited Bubblewrap 0.11.2 Linux payloads, verify their pinned SHA-256
  digests before execution, and add reproducibility and escape CI gates.
- d048c24: Add the authorization-gated EV Authenticode and Microsoft Store migration contract, no-secret CI dry-run, offline negative fixtures, and fail-closed release evidence verifier.
- 3d5fb0e: Reject changesets that reference packages removed by the GitHub Release native distribution migration.
- c22ea6d: Add explicit L2 Authenticode self-sign smoke evidence, macOS notarization credential gating, and accurate native target pass-ratio disclosure without claiming production signatures or unverified Windows sandbox tiers.
- 3750319: Make the Windows Authenticode smoke test deterministic by creating, trusting,
  using, and removing its ephemeral code-signing certificate through native
  Windows certificate APIs.
- e87079f: Add a fail-closed, deterministic 8-target by 3-tier release evidence matrix and assertion gate that preserves native, cross, QEMU, real-hardware, signing, and notarization distinctions.
