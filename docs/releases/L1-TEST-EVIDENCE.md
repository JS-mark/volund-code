# L1 automated test evidence

This map is an index into independently runnable tests for the automated and
security requirements in `RELEASE-CHECKLIST-L1.md` sections 2–8 and 10–11. A
passing aggregate test command is not evidence unless the relevant scenario is
named below.

Run one entry with:

```sh
pnpm --filter <package> test -- --testNamePattern '<test name>'
```

Run the complete TypeScript gate with:

```sh
pnpm turbo run typecheck test build --force
```

## Section 2 — core

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| 17-event contract | `@apollo-code/core` | `src/event-bus.test.ts` — `exposes the complete L1 event contract` |
| UUIDv7 event IDs | `@apollo-code/core` | `src/event-bus.test.ts` — `emits ordered UUIDv7 events` |
| subscriber deduplication | `@apollo-code/core` | `src/event-bus.test.ts` — `deduplicates replayed events per subscriber` |
| PromptComposer injection | `@apollo-code/core` | `src/runner.test.ts` — `injects composed system prompt` |
| 25-loop limit | `@apollo-code/core` | `src/runner.test.ts` — `limits tool loops to 25` |
| interrupt propagation | `@apollo-code/core` | `src/runner.test.ts` — `propagates abort to provider stream` |
| sticky provider lock and interrupted output invalidation | `@apollo-code/core` | `src/runner.test.ts` — `locks at first tool_use and rejects cross-provider retry without persisting partial output` |
| router retry decision | `@apollo-code/core` | `src/runner.test.ts` — `uses the router retry decision before sticky lock without picking again` |
| session-only permission cache | `@apollo-code/core` | `src/session.test.ts` — `does not persist a permission cache in SessionState` |

## Section 3 — provider and router

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| complete ProviderClient contract | `@apollo-code/provider-kit` | `src/index.test.ts` — `requires the complete L1 ProviderClient surface` |
| multimodal messages and RawMeta | `@apollo-code/provider-kit` | `src/index.test.ts` — `keeps multimodal messages and provider-native metadata at the boundary` |
| normalized stream chunk union | `@apollo-code/provider-kit` | `src/index.test.ts` — `makes normal completion, interruption, usage, tools, and errors explicit chunks` |
| Message ↔ Anthropic conversion | `@apollo-code/provider-anthropic` | `src/index.test.ts` — `converts neutral multimodal and tool messages` |
| streaming TextDecoder | `@apollo-code/provider-anthropic` | `src/index.test.ts` — `uses streaming TextDecoder across UTF-8 boundaries` |
| interruption/stop exclusivity | `@apollo-code/provider-anthropic` | `src/index.test.ts` — `emits interrupted instead of stop for incomplete and aborted streams` |
| ProviderError mapping | `@apollo-code/provider-anthropic` | `src/index.test.ts` — `maps errors` |
| credential, system, and AbortSignal ports | `@apollo-code/provider-anthropic` | `src/index.test.ts` — `passes credentials, system, and AbortSignal through injected ports` |
| SingleProviderRouter pick and explicit model | `@apollo-code/router` | `src/index.test.ts` — `honors an explicit model` |
| retry/give-up decision | `@apollo-code/router` | `src/index.test.ts` — `retries retryable errors and gives up otherwise` |
| unified picker alias precedence | `@apollo-code/ui` | `src/integration.test.ts` — `puts an alias before a same-named file and supports explicit file mode` |

## Section 4 — tools, permissions, and sandbox bridge

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| Tool contract surface | `@apollo-code/tool-kit` | `src/index.test.ts` — `requires schema, permission, abort-aware context, and normalized result` |
| fixed builtin names and disposal | `@apollo-code/tool-kit` | `src/index.test.ts` — `registers builtins under fixed names and disposes them` |
| MCP/plugin name prefixes | `@apollo-code/tool-kit` | `src/index.test.ts` — `enforces MCP and plugin namespaces` |
| duplicate registration rejection | `@apollo-code/tool-kit` | `src/index.test.ts` — `rejects duplicate names regardless of source` |
| seven tools and destructive sandbox declarations | `@apollo-code/tools` | `src/index.test.ts` — `registers seven tools and destructive tools require sandbox` |
| schema validation before permission | `@apollo-code/tools` | `src/index.test.ts` — `validates before permission` |
| long tool-result truncation | `@apollo-code/tools` | `src/index.test.ts` — `middle-truncates long output` |
| eight-step permission order and conflicts | `@apollo-code/permission` | `src/index.test.ts` — `puts project and global deny rules above session cache and explicit allows`; `covers the cache, project, global, dangerous, and prompt conflict matrix`; `conservatively auto-allows cwd reads` |
| serialized permission prompts and session cache | `@apollo-code/permission` | `src/index.test.ts` — `serializes prompts and caches session grants` |
| conservative cwd read auto-allow | `@apollo-code/permission` | `src/index.test.ts` — `conservatively auto-allows cwd reads` |
| every raw Bash command prompts, including shell-control edge cases | `@apollo-code/permission` | `src/index.test.ts` — `prompts for every raw Bash command, including shell-control edge cases` |
| raw Bash denies when no prompt exists | `@apollo-code/permission` | `src/index.test.ts` — `denies every ungranted raw Bash command when no prompt is available` |
| explicit Bash grants, persistence port fake contract/reload isolation, exact session cache, and dangerous bypass order | `@apollo-code/permission` | `src/index.test.ts` — `honors explicit project and global Bash grants without prompting`; `records prompted Bash grants and caches only an explicit session decision`; `keys Bash session grants by the exact command and prompts again for variants`; both `reloads an exact ... Bash grant without widening to variants` cases (a persistence port fake contract, not evidence for the real TOML loader); `keeps the explicit dangerous bypass after deny rules and logs its use` |
| production raw Bash permission chain denies before native execution | `apollo-code` | `src/runtime.test.ts` — `uses explicit none interaction to deny a real BashTool before native execution` |
| production shared-composition raw Bash event/spec/order integration | `apollo-code` | `src/runtime.test.ts` — `uses the production permission chain for a real BashTool before one native invocation` (the helper shared by `createProductionPorts`, real `BashTool` + `ToolExecutor`, exact `toolUseId`, full Bash/fs `PermissionSpec`, event → prompt → one native invocation; this is not claimed as a complete Runner E2E) |
| production dangerous Bash bypass opt-in | `apollo-code` | `src/runtime.test.ts` — `opens the Bash bypass only when production security configuration is explicitly enabled` |
| frozen per-session security/interaction policy and child cache isolation | `apollo-code` | `src/runtime.test.ts` — `freezes root policy, shares it with children, and fails closed for an orphan child`; `inherits policy without sharing a parent PermissionManager session cache`; `opens the Bash bypass only when production security configuration is explicitly enabled` |
| shared secret-detection normalization | `@apollo-code/shared` | `src/secret-detector.test.ts` — `normalizes Unicode and invisible separator variants`; `shares the ... detection normalization without mutating caller data` (NFKC/Cf/Unicode-hyphen table); `recognizes the canonical credential key after detection normalization` and `does not widen the canonical credential key grammar` |
| display-safe, secret-safe approval preserves raw execution | `apollo-code` | `src/runtime.test.ts` — `keeps ordinary Cf raw for native execution and exact session grant keys`; `shows a deny-only marker when sanitization would hide part of a raw Bash command`; `redacts a bare ... secret in line display and the permission event` (provider/GitHub/AWS/JWT plus normalized Bearer/token/Cf/NFKC/Unicode-hyphen table); `enforces deny after a tui handler tries to approve ... hidden details` (normalized grammar table); `redacts values behind a normalized ... in line display and events`; `fails closed for an approval ... without leaking it to the event` |
| sandbox tier frozen per process | `@apollo-code/native-bridge` | `src/sandbox.test.ts` — `is frozen for the lifetime of the process` |
| worker handshake/restart/idle lifecycle | `@apollo-code/native-bridge` | `src/worker-pool.test.ts` — all three named tests |
| malformed worker protocol handling | `@apollo-code/native-bridge` | `src/ipc.test.ts` — `rejects malformed protocol frames without losing later frames` |
| dangerous-mode telemetry, confirmation, and red banner | `apollo-code` | `src/cli.test.ts` — `rejects dangerous mode without an explicit confirmation and emits one event`; `shows a red warning and records permission bypass once`; `never enters a none-tier session without explicit confirmation` |
| sandbox tier disclosure | `@apollo-code/ui` | `src/security.test.ts` — `discloses the probed tier and its limitations` |

Rust backend, digest, license, target, and escape evidence belongs to the native
CI evidence owned by APO-12; it is not inferred from TypeScript unit tests.

## Section 5 — storage, config, and credentials

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| JSONL v1, append-only fsync, delta omission | `@apollo-code/storage` | `src/index.test.ts` — `writes v first, skips deltas, fsyncs append-only records` |
| attachment bytes excluded from JSONL | `@apollo-code/storage` | `src/index.test.ts` — `rejects inline attachment bytes` |
| AGENT/CLAUDE fallback and safe include | `@apollo-code/storage` | `src/index.test.ts` — `loads AGENT over CLAUDE and expands safe includes` |
| sensitive include denial placeholder | `@apollo-code/storage` | `src/index.test.ts` — `leaves a denial placeholder for sensitive includes`; `recognizes Windows separators in sensitive include paths` |
| resume and incomplete-turn abort | `apollo-code` | `src/runtime.test.ts` — `resumes the last snapshot, aborts an incomplete turn, and emits session.resumed` |
| config precedence and protected data-flow keys | `@apollo-code/config` | `src/index.test.ts` — `filters project data-flow keys and applies env/flags last` |
| noninteractive project-config deny | `@apollo-code/config` | `src/index.test.ts` — `denies project config non-interactively by default` |
| cwd canonicalization and sensitive-prefix rejection | `@apollo-code/shared` | `src/path-guard.test.ts` — all named tests |
| keychain-before-env and sanitized auth events | `@apollo-code/auth` | `src/index.test.ts` — `resolves keychain before env without leaking payload` |
| verify-before-store | `@apollo-code/auth` | `src/index.test.ts` — `verifies before storing` |
| Argon2id/AES-GCM and no plaintext | `@apollo-code/auth` | `src/encrypted-store.test.ts` — `round trips using Argon2id and AES-GCM without plaintext on disk` |
| sink sanitization | `@apollo-code/telemetry` | `src/index.test.ts` — `sanitizes every event before the local sink` |

## Section 6 — context

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| ContextPolicy ownership | `@apollo-code/provider-kit` | `src/index.test.ts` — `owns the replaceable context policy contract` |
| model-keyed token cache, native/fallback estimate, budget reserve | `@apollo-code/context` | `src/index.test.ts` — `includes model in token cache key and reserves budget` |
| tool-pair and turn-boundary preservation | `@apollo-code/context` | `src/index.test.ts` — `keeps tool pairs and turn boundaries` |
| asynchronous compaction hook veto | `@apollo-code/context` | `src/index.test.ts` — `respects preCompact veto` |

## Section 7 — PromptComposer and untrusted content

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| register/compose/invalidate, stable priority, annotation separator | `@apollo-code/core` | `src/prompt-composer.test.ts` — `filters, sorts stably, annotates, interpolates and invalidates` |
| priority-1000 builtin | `@apollo-code/core` | `src/prompt-composer.test.ts` — `provides the priority-1000 builtin` |
| include path roots, permission, atomic open, non-md, sensitive, cycle, depth/limit, placeholder | `@apollo-code/storage` | `src/index.test.ts` — the three PromptLoader tests listed in section 5 |
| source-traceable, injection-resistant untrusted wrapper | `@apollo-code/core` | `src/untrusted.test.ts` — `traces source and cannot be closed by injected content` |

## Section 8 — terminal UI

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| alias/file picker semantics | `@apollo-code/ui` | `src/integration.test.ts` — `puts an alias before a same-named file and supports explicit file mode` |
| serialized prompt handler | `@apollo-code/ui` | `src/integration.test.ts` — `serializes permission prompts` |
| Ink chat shell, stream buffering, slash suggestions, permission queue | `@apollo-code/ui` | `src/tui.test.tsx` — `renders the static Ink shell and stream updates`; `renders slash command suggestions`; `reports unavailable and unknown slash commands without throwing`; `buffers stream deltas before rendering`; `renders queued permission prompts` |
| display-safe TUI permission approval | `@apollo-code/ui` | `src/permission-display.test.ts` — `permission display safety` table and fail-closed budget/shape cases; `src/tui.test.tsx` — `renders queued permission prompts`; `renders sensitive permission details as deny-only and ignores approval keys` |
| explicit TUI/line/none interaction routing and JSON-on-TTY denial | `apollo-code` | `src/cli.test.ts` — `routes promptless TTY chat to the Ink UI port`; `does not register permission prompts in yolo TUI mode`; `keeps --no-tui promptless chat on the line fallback even when TTY is available`; `uses NDJSON only for a JSON chat and disables human/TUI output`; `forces JSON-on-TTY to none and drives the real Bash permission chain without readline` |
| interrupted output withdrawn on restore | `@apollo-code/ui` | `src/integration.test.ts` — `restores a transcript without reviving withdrawn output`; `src/security.test.ts` — `marks interrupted output as withdrawn and records exit` |
| SIGINT keeps session alive | `apollo-code` | `src/signals.test.ts` — `interrupts the current turn on SIGINT without ending the session` |
| SIGTERM/SIGHUP flush and end | `apollo-code` | `src/signals.test.ts` — the SIGTERM and SIGHUP named tests |

Static package-boundary rules are enforced by repository lint/config checks;
they are not represented as runtime assertions in this table.

## Sections 10–11 — CLI and onboarding

| Requirement | Package | Test file and test name |
| --- | --- | --- |
| citty command surface and nested commands | `apollo-code` | `src/cli.test.ts` — `declares the complete L1 command surface` |
| JSON doctor output and strict failure | `apollo-code` | `src/cli.test.ts` — `fails strict doctor and precisely lists unavailable integrations` |
| cwd normalization | `apollo-code` | `src/cli.test.ts` — `normalizes --cwd before starting a session` |
| dangerous flags emit once, confirm, and render warning | `apollo-code` | the three dangerous-mode tests listed in section 4 |
| strict degraded sandbox exit 3 | `apollo-code` | `src/cli.test.ts` — `exits 3 when strict sandbox receives a degraded tier` |
| privacy and sandbox disclosure before session/config writes | `@apollo-code/ui` | `src/security.test.ts` — `states the local-only telemetry default`; `discloses the probed tier and its limitations` |
| resume command semantics | `apollo-code` | `src/cli.test.ts` — `resumes a persisted session through the session runtime port` |

Manual onboarding gates remain manual and are tracked by APO-13. This document
does not convert a manual observation or an unavailable integration into a unit
test pass.

## Manual smoke evidence

2026-08-08, local macOS development checkout, command:
`node apps/cli/dist/apollo.js chat`.

Observed:

- none-tier sandbox confirmation was required before session start;
- after confirmation, Ink rendered the session header, sandbox status, empty
  transcript, and `> ` input line;
- `exit` followed by newline ended the session and restored the cursor;
- no credential, provider prompt, or sensitive task content was recorded.

This smoke verifies local TUI startup and exit cleanup only. It is not Anthropic
dog-food evidence and does not change `L1-DOGFOOD.md` from blocked.
