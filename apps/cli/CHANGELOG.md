# volund-code

## 0.2.0

### Minor Changes

- 5344f22: Config-provided auth (spec §8.4): `AuthManager` gains Layer 4 — user-level `~/.volund/config.toml` `[auth] <provider>_api_key` (explicit opt-in; project-level forbidden per §8.3.1) resolving after keychain/encrypted-file/env with `layer: 4` telemetry. `[auth] skipAuth = true` (user-level only) skips credential resolution entirely: requests go out without `x-api-key`, health/status report `skipped (auth.skipAuth)`, and the first skip emits `auth.credential.skipped`. `provider-anthropic`'s `CredentialPort` now allows `undefined` (header omitted); the CLI also wires `provider.anthropic.baseUrl` into `AnthropicClient` for gateway/proxy deployments. Registry + appendix C.2 rows added; `pnpm verify:config-docs` stays green.
- 7e94e19: Clipboard attachment paste (spec §7.5.2): Ctrl+V in the TUI reads the system clipboard — images are staged content-addressed into the session attachment store and inserted as atomic, sequentially numbered `[image_1]` chips, copied files become `[file: <name>]` path references, and plain text is inserted in place. Dragging a file into the terminal or pasting a resolvable file path attaches it too (bracketed paste; in-workspace files by path, out-of-workspace images staged as blobs). Cmd+V pastes images too: an empty bracketed paste (clipboard holds an image, no text) triggers the clipboard read — the same onEmptyPaste semantics as Claude Code. Pasting requires no permission prompt (the chip is a local reference; content leaves only when the message is sent); submissions expand chips into image/file content parts for vision-capable providers (others degrade to a textual note). History and transcripts keep only chip text, never binary.

  The `@` unified picker (spec §7.5.3) is wired into the input box: typing `@` lists model aliases (⭐) and workspace files (📄) with prefix filtering; selecting a file attaches it, selecting a model sets the turn-level override. TIFF-only clipboards convert via `sips`.

  A `/paste` command provides a keybinding-independent attach path (for terminals that capture Ctrl+V), the permission prompt accepts `y` as allow-once, and the input box no longer loses its draft and attachment chips when the welcome screen hides (it is no longer remounted on view switches).

  The input box now supports cursor movement (←/→, Home/End, Ctrl+A/Ctrl+E) with edits applying at the cursor; pasted multi-line text no longer triggers premature submission.

- e569469: Remote control relay (REM-r1). The gateway is now a **standalone relay process** — `@volund/gateway-server` ships a `volund-gateway` bin (`dist/bin.js`, also `pnpm --filter @volund/gateway-server start`) and the `volund gateway` CLI subcommand is **removed**: the gateway no longer embeds a local session runner (direct mode remains library-only) and is configured purely via `GATEWAY_*` env. In relay mode there is no in-process session — desktop volund dials out to `GET /uplink` (reverse tunnel, machine OAuth client with `uplink` scope), registers its instance, and all `/v1/*` traffic is routed to it via the RPC-ized `RemoteHub` (implements `GatewayHubLike`; sync `active`/`pendingPermissionIds` served from register/state snapshots). Device pairing: one-shot 5-min codes (`pairing.create` over the uplink) redeemed at public `POST /pairing/redeem` (IP rate-limited) into 30-day device JWTs bound to the machine client; device registry persists to `<home>/gateway/devices.json`, revocation kills tokens immediately. `staticDir` serves the new mobile site same-origin (CSP nonce, SPA fallback, immutable hashed assets); mobile asset resolution (`VOLUND_MOBILE_ASSET_DIR` → bundled dir → repo `apps/mobile/out`) now lives in the gateway package, so the mobile site is hosted entirely independent of the CLI. The mobile site can also be **deployed standalone** (`deploy/mobile/` nginx image or any static host): pairing links then point at the mobile origin via the new `mobilePublicUrl` gateway option (`GATEWAY_MOBILE_PUBLIC_URL`) and carry `&gw=<gateway URL>`, which the site persists to localStorage and uses for all cross-origin REST/WS calls (the gateway origin must be allowlisted with `GATEWAY_CORS_ORIGINS`); a gateway-address field on the mobile pair view covers manual entry. The gateway protocol is now a first-class contract: `packages/gateway-server/PROTOCOL.md` specifies both planes (machine uplink frames + hub RPC methods, client REST + `/v1/ws` frames, pairing, error codes, compatibility rules) and `src/protocol.ts` exports the TypeScript frame types (`MachineFrame`/`GatewayFrame`/`ClientFrame`/`ServerFrame`) — any application implementing the protocol can integrate with a deployed gateway, and both the server (`uplink.ts`) and the desktop client (`remote-link`) are compile-time anchored to the contract via `satisfies`. New endpoint `GET /v1/sessions/active/transcript`; event broadcast is now filtered per source machine. OAuth JWT primitives extracted (`signGatewayJwt`/`verifyGatewayJwt`); gateway env/credential resolution (`resolveRelayConfig`/`resolveGatewayCredentials`) and model-alias helpers (`readModelAliases`/`createGatewayModelResolver`) moved from the CLI into the package.

  New package `@volund/remote-link`: desktop-side uplink client — token caching, exponential-backoff reconnect, hub RPC serving with local cwd confinement, event/state forwarding, pairing/device commands. New app `apps/mobile` (@volund/mobile): mobile web console (pair via `#pair=CODE`, sessions list/switch, streaming chat with tool/permission cards, device info) talking gateway WS `/v1/ws` + REST only. Web console gains the 远程控制 tab (`RemotePage`): explicit start/stop-service buttons + gateway credentials ([remote] config keys, secret write-only), channel cards (mobile-web live; wechat/wecom placeholders), pairing QR, device management — backed by new `/api/v1/remote` routes on web-server (`RemoteControlPort`, capability flag). The uplink starts together with the embedded Web console when volund.js launches: `[remote] enabled=true` + credentials → auto dial-out, start/stop persists back to `remote.enabled`; no separate desktop command. deploy/gateway image now builds and runs the standalone gateway (`node /app/gateway/dist/bin.js`) and ships the mobile site. plugin-sdk defines the forward-looking `ChannelPlugin` contract. Config schema/registry/appendix C gain `[remote]` keys (client_secret project-forbidden); `pnpm verify:config-docs` green.
  Image attachments ride the relay end-to-end: `POST /v1/attachments` stages raw bytes into the machine's AttachmentStore over the uplink (new `hub.stageAttachment` RPC with a 60s timeout; uplink WS frame cap raised to 32 MiB while `/v1/ws` stays at 1 MiB), and `turn.submit` accepts `attachments` handle references validated at the WS boundary; the mobile composer gains an image picker with staged-chips UI and thumbnail echoes.
  Model switching reaches the relay: `GET /v1/models` now proxies the machine over a new `models.list` uplink RPC (falling back to an empty list while the machine is offline) and returns a `current` field alongside the OpenAI-shaped `data`; the CLI hub reuses the Web console's model listing (current model + anthropic aliases), and the mobile site gains a header model picker (device-persisted, selecting the default clears the override) that sends `model` on every `turn.submit`.
  Machine presence is now visible to relay clients: the gateway synthesizes `machine.offline`/`machine.online{cwd}` view events on uplink drop/(re)register (a replaced stale connection does not emit a spurious offline), and the mobile site surfaces them as a banner — offline sets 「本机离线…」and online clears just that notice; WS command error replies (e.g. `gateway_uplink_offline`) also land on the banner instead of being silently dropped, and a failed auto `session.start` now resets the retry latch.
  Same-credential uplink contention no longer wars: a machine whose connection is closed with 1008 `replaced by a newer uplink` now stands down (state `off` with an explicit reason) instead of redialing into a registration fight.

- 9e969d3: Make adaptive runtime tuning default-off and harden its persistence boundary. Configuration now
  requires an explicit own-property boolean opt-in, context tuning uses exported frozen bounds plus
  an atomic cross-field snapshot projection, and non-context persisted apply remains deny-only.
  Configuration parsing also rejects prototype-pollution key segments
  (`__proto__` / `constructor` / `prototype`) fail-closed. Evolution records are written as strict
  version-1 JSONL, legacy records retain explicit compatibility provenance, invalid or future
  records fail closed, and rollback consumes only validated context history. The flat V1 format is
  intentionally not yet crash-atomic or evidence-grade; record identity, sequencing, dual-file
  recovery, and migration diagnostics remain a separate T1b change.
- a0eecf1: Give the adaptive tuning store crash-recoverable, cross-process-coordinated persistence.
  New records are written as flat schema-version-2 lines carrying a store-assigned record id and a
  per-namespace monotonic sequence (strictly increasing; regressions are dropped with a fixed
  diagnostic). Every dual append runs under a best-effort cross-process lock and a
  `.evolution-txn.json` journal (PREPARED → NAMESPACE_DURABLE → BOTH_DURABLE, fsync at each step):
  recovery proves a commit only when both files end with the exact journalled record, aborts torn
  partial writes back to the journalled pre-sizes, and fails closed into a RECOVERY_REQUIRED state
  that refuses appends until manual intervention. `volund doctor` surfaces the tuning journal
  health. Honesty limits: file content is fsynced but new-file creation cannot be made durable
  across power loss without a directory fsync (no portable Node API; Windows deployments must
  disclose), the lock is a local coordination primitive rather than a security boundary, and the
  audit trail is still not promotion evidence for later shadow/apply stages without further review.

### Patch Changes

- 7ad5a34: Temporarily contain legacy plugin install and activation until Catalog v2 and the verified capability ABI can reopen them safely. Production manager/runtime paths are deny-only, stale approvals are projected disabled without a state rewrite, plugin machine errors follow the two-event NDJSON contract, and the published package excludes all test authority and legacy host seams.
- 7cfa6a4: Restore the /model selection across resume: the choice is now persisted as a `session.model_changed` event (appendix D.2, 26th event) in the session JSONL, `replaySessionState` rebuilds `SessionState.model` from it (events before the 20-turn tail window are replayed too, last one wins), and submits without a per-turn override use the pinned model as `explicitModel`. The TUI wires `onModelSelect` to session persistence, the model picker shows the restored model after `volund resume` / `/resume` / web-driven session switches, and switching to an unpinned session clears the stale override back to the global config default.
- Updated dependencies [5344f22]
- Updated dependencies [7e94e19]
- Updated dependencies [ad0e7b5]
- Updated dependencies [7ad5a34]
- Updated dependencies [7d1147e]
- Updated dependencies [4ac2411]
- Updated dependencies [4b83a10]
- Updated dependencies [e569469]
- Updated dependencies [9e969d3]
- Updated dependencies [7cfa6a4]
- Updated dependencies [a0eecf1]
- Updated dependencies [3697fb7]
- Updated dependencies [001768a]
  - @volund/auth@0.2.0
  - @volund/provider-anthropic@0.2.0
  - @volund/shared@0.2.0
  - @volund/native-bridge@0.2.0
  - @volund/ui@0.2.0
  - @volund/plugin-runtime@0.1.1
  - @volund/config@0.2.0
  - @volund/core@0.2.0
  - @volund/gateway-server@0.2.0
  - @volund/remote-link@0.2.0
  - @volund/web-server@0.2.0
  - @volund/plugin-sdk@0.2.0
  - @volund/storage@0.2.0
  - @volund/app-runtime@0.2.0
  - @volund/mcp-client@0.1.1
  - @volund/permission@0.1.1
  - @volund/provider-gemini@0.1.1
  - @volund/provider-kit@0.1.1
  - @volund/provider-ollama@0.1.1
  - @volund/provider-openai@0.1.1
  - @volund/skills-runtime@0.1.1
  - @volund/subagent@0.1.1
  - @volund/telemetry@0.1.1
  - @volund/tool-kit@0.1.1
  - @volund/tools@0.1.1
  - @volund/kernel@0.1.1
  - @volund/context@0.1.1
  - @volund/router@0.1.1

## 0.1.0

### Minor Changes

- 322c399: Add atomic MultiEdit transactions, session-scoped file backups, conflict-safe restore and durable resume recovery.
- ef83e9a: Add the versioned memory runtime, crash-safe local repository, scope policy, and production composition-root wiring.
- 0fdd2db: Add the Chat `/memory` browser, search, paging, details, guarded editing, deletion, and pin controls while sharing Memory fact, recall, ACL, pre-write, cursor, and optimistic concurrency behavior with the CLI.
- 51a8d26: Add the responsive volund Code startup status screen and stable bordered command input band.
- bca787c: Add permission-gated Memory plugin capabilities, attachment reference lifecycles, and local-only versioned import/export with dry-run conflict reports and crash rollback.
- 3a6b644: Add a secret-safe read-only status view model, runtime aggregation adapter, and JSON-safe section formatter for the upcoming `/status` panel.
- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- 3059a39: Add deterministic, fail-closed Homebrew, winget, and apt/portable channel manifest dry-runs for all standalone targets.
- 110ceb6: Add local scoped memory recall, crash-recoverable keyword indexing, read-only diagnostics, and atomic reindex CLI workflows.
- 8edb498: Add the redacted `/status` three-tab Ink panel, safe preference editing, and JSON/text status fallbacks.
- 5c195aa: Add the L1 unified model/file picker, serialized permission and diff presentation models, interrupted transcript recovery, and CLI session resume wiring.
- 1e38fa8: Connect enabled plugin Memory lifecycle hooks to the production composition root with scope-gated
  payloads, fail-closed vetoes and timeouts, recursion protection, metadata-only auditing, and
  post-commit lifecycle events shared by CLI, TUI, model, import, and Plugin write paths.
- 22375da: Add the interactive `/resume` command with shared session discovery, filtering, and atomic session switching.
- e9b0aea: Add a dynamic slash-command registry and connect plugin `commands.register` contributions to the interactive CLI with lifecycle-aware disposal.
- 6ce20ca: Activate approved enabled plugins in the native sandbox host, bridge registered tool callbacks into live CLI sessions, dispose them across disable and uninstall, and add a secret-free real sandbox lifecycle E2E.
- c6e155d: Replace the disconnected CLI shell with production L1 wiring for Runner, Anthropic, permissions, native sandbox workers, session JSONL resume, telemetry, auth, config health, and strict doctor checks.
- 823ad19: Add an interactive session picker for `volund resume`, including fuzzy search, resilient session discovery, and structured non-TTY errors.
- 5a4987c: Ship the Rolldown single-file CLI and the twelve L1 native release assets,
  with three-OS TypeScript, four-target native, escape, doctor, digest, and
  universal2 CI evidence. Linux arm64 QEMU evidence remains partial verification
  and is never presented as real-hardware validation.
- cf93b8c: Add local sandbox violation telemetry aggregation, a security panel, and CLI doctor/export/clear controls with defense-in-depth redaction.
- e562b07: Add the versioned NDJSON contract for machine-readable chat output while preserving single-document JSON for management commands.
- 4bb00af: Add the standalone binary assembly contract and verified bundled native resolver.
- 99c77bf: Add summary context compaction with safe sliding fallback, context policy contribution contracts, and transparent CLI/TUI context controls.
- b365939: Add bounded MCP stdio and HTTP/SSE transports, lifecycle handling, tool registration, cancellation, reconnect, and untrusted response wrapping.
- 6c2bed5: Add a canonical directory trust gate, persistent exact/tree scopes, interactive keyboard prompt, non-interactive opt-in, and trust management commands.
- d8d712d: Add the L2 context EvolutionEngine, sanitized append-only tuning audit storage, tuning memory persistence, and evolution show/rollback CLI.
- b69a471: Add paginated concurrency-safe Memory CRUD, mandatory pre-write validation, and production Memory model tools.
- d631d20: Add the built-in Task tool and an isolated three-level subagent runtime with injected RunnerFactory, bounded budgets and concurrency, cancellation cascading, tagged event bubbling, and untrusted result handling.
- d348244: Add progressive skill disclosure, PromptComposer runtime wiring, durable image attachment handles, provider vision validation, and text-only capability fallback.
- cadb8ec: Add local plugin lifecycle commands, publish the plugin APIs in TypeDoc, and include an auditable community plugin template and dog-food runbook.
- 80edf03: Add the stable Memory CLI and bounded, untrusted pinned-memory PromptComposer provider.

### Patch Changes

- c05ab16: Add the L1 user documentation site and release acceptance records for Anthropic dog-food and human sign-off.
- c6e1d99: Replace artifact-based milestone checkmarks with an evidence-gated R0–R6 roadmap and frozen capability traceability baseline.
- 7c57d3f: Keep the CLI open in interactive chat after selecting and restoring a saved session.
- af49eb6: Add an auditable L1 final-verification runbook covering candidate freeze,
  four-target evidence, real Anthropic dog-food, human sign-off, and publication
  boundaries.
- 7d36404: Connect masked Anthropic login, encrypted credential storage, logout, strict doctor auth status,
  and a clearly labeled mock-only L1 pre-flight record.
- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
- 5a1dc6c: Document the independent L1 readiness audit, target-specific sandbox evidence,
  and release blockers without claiming publication.
- f5d0ae2: Add Oxlint and Oxfmt checks, validate workspace TypeScript output directories, keep source imports extensionless, and add runtime JavaScript extensions to emitted ESM during builds.
- 040416f: Add a no-secret process-level R1 gate for the built JSON and no-TUI CLI roots.
- 5ad88e9: Add TypeDoc-backed API documentation, Renovate policy, Changesets release automation, and an evidence-accurate L2 release checklist.
- Updated dependencies [322c399]
- Updated dependencies [7cbaab5]
- Updated dependencies [ef83e9a]
- Updated dependencies [7472330]
- Updated dependencies [0fdd2db]
- Updated dependencies [51a8d26]
- Updated dependencies [bca787c]
- Updated dependencies [3f92c86]
- Updated dependencies [b2851d5]
- Updated dependencies [d90cf18]
- Updated dependencies [b90729e]
- Updated dependencies [3a6b644]
- Updated dependencies [340adfc]
- Updated dependencies [d048c24]
- Updated dependencies [5e3e011]
- Updated dependencies [110ceb6]
- Updated dependencies [3d5fb0e]
- Updated dependencies [8edb498]
- Updated dependencies [5c195aa]
- Updated dependencies [2d72f45]
- Updated dependencies [7a96f71]
- Updated dependencies [1e38fa8]
- Updated dependencies [e6f71f1]
- Updated dependencies [b34e712]
- Updated dependencies [1dafc88]
- Updated dependencies [22375da]
- Updated dependencies [e9b0aea]
- Updated dependencies [6ce20ca]
- Updated dependencies [823ad19]
- Updated dependencies [976eb21]
- Updated dependencies [911e807]
- Updated dependencies [5a4987c]
- Updated dependencies [cf93b8c]
- Updated dependencies [54d0d7a]
- Updated dependencies [ec4d987]
- Updated dependencies [e562b07]
- Updated dependencies [41fbb46]
- Updated dependencies [0ec7999]
- Updated dependencies [3780728]
- Updated dependencies [c16ea41]
- Updated dependencies [7d36404]
- Updated dependencies [4bb00af]
- Updated dependencies [99c77bf]
- Updated dependencies [344f874]
- Updated dependencies [4b4f0ac]
- Updated dependencies [568cb92]
- Updated dependencies [c22ea6d]
- Updated dependencies [3750319]
- Updated dependencies [5a9f08f]
- Updated dependencies [4067e1e]
- Updated dependencies [6c2bed5]
- Updated dependencies [0cc9b4c]
- Updated dependencies [8521920]
- Updated dependencies [e43cf9d]
- Updated dependencies [02ebe86]
- Updated dependencies [eeca5e1]
- Updated dependencies [4bdee12]
- Updated dependencies [d8d712d]
- Updated dependencies [e87079f]
- Updated dependencies [b69a471]
- Updated dependencies [d631d20]
- Updated dependencies [d348244]
- Updated dependencies [cadb8ec]
- Updated dependencies [3816925]
- Updated dependencies [5cc5254]
- Updated dependencies [4842243]
- Updated dependencies [01ffdbd]
- Updated dependencies [ad4613e]
- Updated dependencies [84c87cb]
- Updated dependencies [f4e0e08]
- Updated dependencies [80edf03]
  - @volund/tools@0.1.0
  - @volund/storage@0.1.0
  - @volund/native-bridge@0.1.0
  - @volund/ui@0.1.0
  - @volund/plugin-sdk@0.1.0
  - @volund/plugin-runtime@0.1.0
  - @volund/router@0.1.0
  - @volund/shared@0.1.0
  - @volund/core@0.1.0
  - @volund/provider-kit@0.1.0
  - @volund/auth@0.1.0
  - @volund/config@0.1.0
  - @volund/context@0.1.0
  - @volund/permission@0.1.0
  - @volund/telemetry@0.1.0
  - @volund/tool-kit@0.1.0
  - @volund/provider-anthropic@0.1.0
  - @volund/subagent@0.1.0
  - @volund/skills-runtime@0.1.0
