# @volund/shared

## 0.2.0

### Minor Changes

- 5344f22: Config-provided auth (spec §8.4): `AuthManager` gains Layer 4 — user-level `~/.volund/config.toml` `[auth] <provider>_api_key` (explicit opt-in; project-level forbidden per §8.3.1) resolving after keychain/encrypted-file/env with `layer: 4` telemetry. `[auth] skipAuth = true` (user-level only) skips credential resolution entirely: requests go out without `x-api-key`, health/status report `skipped (auth.skipAuth)`, and the first skip emits `auth.credential.skipped`. `provider-anthropic`'s `CredentialPort` now allows `undefined` (header omitted); the CLI also wires `provider.anthropic.baseUrl` into `AnthropicClient` for gateway/proxy deployments. Registry + appendix C.2 rows added; `pnpm verify:config-docs` stays green.
- 7e94e19: Clipboard attachment paste (spec §7.5.2): Ctrl+V in the TUI reads the system clipboard — images are staged content-addressed into the session attachment store and inserted as atomic, sequentially numbered `[image_1]` chips, copied files become `[file: <name>]` path references, and plain text is inserted in place. Dragging a file into the terminal or pasting a resolvable file path attaches it too (bracketed paste; in-workspace files by path, out-of-workspace images staged as blobs). Cmd+V pastes images too: an empty bracketed paste (clipboard holds an image, no text) triggers the clipboard read — the same onEmptyPaste semantics as Claude Code. Pasting requires no permission prompt (the chip is a local reference; content leaves only when the message is sent); submissions expand chips into image/file content parts for vision-capable providers (others degrade to a textual note). History and transcripts keep only chip text, never binary.

  The `@` unified picker (spec §7.5.3) is wired into the input box: typing `@` lists model aliases (⭐) and workspace files (📄) with prefix filtering; selecting a file attaches it, selecting a model sets the turn-level override. TIFF-only clipboards convert via `sips`.

  A `/paste` command provides a keybinding-independent attach path (for terminals that capture Ctrl+V), the permission prompt accepts `y` as allow-once, and the input box no longer loses its draft and attachment chips when the welcome screen hides (it is no longer remounted on view switches).

  The input box now supports cursor movement (←/→, Home/End, Ctrl+A/Ctrl+E) with edits applying at the cursor; pasted multi-line text no longer triggers premature submission.

- ad0e7b5: Centralize every cross-module error code in an `ErrorCodes` registry (`error-codes.ts`) covering
  `error.raised` contract codes from appendix B.2, plugin, memory, provider/router, CLI `--json`,
  transport `VOLUND_*`, and testkit domains, with `ErrorCode` typing, appendix/normalized subsets,
  and a `pnpm verify:error-codes` drift check wired into the turbo `test` task so unregistered or
  zombie codes fail CI.
- 7d1147e: Add per-event payload zod schemas for the 19 EventBus events (spec appendix D): `EVENT_SCHEMAS` registry, shared envelope schema with UUIDv7 ids, and `eventEnvelopeFor(type)` replay validation. CI-enforced via `scripts/verify-event-schemas.mjs` against the §2.3 event table.
- 4ac2411: Config unknown-key policy (spec §8.3 / appendix C, r13-I4): full TOML `ConfigSchema` (strict zod objects + dynamic `provider.<name>` / `models.aliases.<alias>` catchalls), `configKeyRegistry` with per-key `projectOverride` annotations aligned to appendix C.2, and `projectOverrideFor`/`isProjectOverrideForbidden` helpers. `@volund/config` gains `validateConfig`/`loadTomlFile` (unknown key → warn + ignore with key + file; known-key type error → `config_invalid` with file + key + expected type) and switches §8.3.1 project filtering to the registry (router.allow_cross_provider_tool_use now project-overridable per C.2). CI-enforced via `scripts/verify-config-docs.mjs` (`pnpm verify:config-docs`) against the appendix C.2 table.
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
- 7cfa6a4: Restore the /model selection across resume: the choice is now persisted as a `session.model_changed` event (appendix D.2, 26th event) in the session JSONL, `replaySessionState` rebuilds `SessionState.model` from it (events before the 20-turn tail window are replayed too, last one wins), and submits without a per-turn override use the pinned model as `explicitModel`. The TUI wires `onModelSelect` to session persistence, the model picker shows the restored model after `volund resume` / `/resume` / web-driven session switches, and switching to an unpinned session clears the stale override back to the global config default.
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

## 0.1.0

### Minor Changes

- 340adfc: Add the L1 CLI and UI product shell with strict diagnostics, guarded workspace paths, sandbox disclosure, dangerous-mode warnings, and replaceable integration ports.
- e6f71f1: Add the versioned extension transport protocol, resource and cancellation contracts, and the canonical normalized error taxonomy with redacted serialization.
- 976eb21: Add the L1 tool, permission, context, prompt, session, configuration, credential, and local telemetry runtime.
- 344f874: Establish the L1 monorepo foundation, neutral provider and tool contracts, immutable session state, and the typed 17-event core bus.

### Patch Changes

- 02ebe86: Reject common provider credentials, authorization values, JWTs, and credential URIs across every Memory write surface before persistence.
