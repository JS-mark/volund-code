# @volund/native-bridge

## 0.2.0

### Minor Changes

- 7e94e19: Clipboard attachment paste (spec §7.5.2): Ctrl+V in the TUI reads the system clipboard — images are staged content-addressed into the session attachment store and inserted as atomic, sequentially numbered `[image_1]` chips, copied files become `[file: <name>]` path references, and plain text is inserted in place. Dragging a file into the terminal or pasting a resolvable file path attaches it too (bracketed paste; in-workspace files by path, out-of-workspace images staged as blobs). Cmd+V pastes images too: an empty bracketed paste (clipboard holds an image, no text) triggers the clipboard read — the same onEmptyPaste semantics as Claude Code. Pasting requires no permission prompt (the chip is a local reference; content leaves only when the message is sent); submissions expand chips into image/file content parts for vision-capable providers (others degrade to a textual note). History and transcripts keep only chip text, never binary.

  The `@` unified picker (spec §7.5.3) is wired into the input box: typing `@` lists model aliases (⭐) and workspace files (📄) with prefix filtering; selecting a file attaches it, selecting a model sets the turn-level override. TIFF-only clipboards convert via `sips`.

  A `/paste` command provides a keybinding-independent attach path (for terminals that capture Ctrl+V), the permission prompt accepts `y` as allow-once, and the input box no longer loses its draft and attachment chips when the welcome screen hides (it is no longer remounted on view switches).

  The input box now supports cursor movement (←/→, Home/End, Ctrl+A/Ctrl+E) with edits applying at the cursor; pasted multi-line text no longer triggers premature submission.

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
