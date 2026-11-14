# Error code reference

Error notices in Volund follow a uniform **`code: English detail`** format (same on
the web console and mobile):

```text
tool_loop_exhausted: Reached the per-turn limit of 25 consecutive tool-call rounds; …
```

- The `code` is a cross-module contract: emitted by core → rendered by the UI →
  classified by telemetry → greppable by you. Every value lives in a single registry,
  [`packages/shared/src/error-codes.ts`](https://github.com/JS-mark/volund-code/blob/main/packages/shared/src/error-codes.ts).
  Codes must be registered before use; `pnpm verify:error-codes` enforces this
  bidirectionally in CI (an unregistered literal fails, and so does a registry entry
  nothing emits).
- Detail text is always English, so it stays grep- and log-friendly. This page is the
  human-readable catalog.
- This page is maintained in lockstep with the registry; if a code shows up in an
  error notice but is missing here, the registry wins — and please file an issue.

## Turn errors (`error.raised`)

These codes surface directly in web/mobile session notices and are the ones you will
meet most often:

| code                                    | meaning                                                                                                                     | trigger & what to do                                                                                                                                 |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tool_loop_exhausted`                   | The turn reached its tool-call loop cap (25 by default, configurable via `runner.maxToolLoopsPerTurn`)                      | Large tasks (e.g. scaffolding a whole project) can exhaust one turn; completed changes are kept — send a follow-up message to continue in a new turn |
| `subagent_budget_exhausted`             | A resource budget ran out (tokens / cost / time / tool calls — the detail names the dimension)                              | Raise the matching budget and continue                                                                                                               |
| `stream_interrupted`                    | The model stream dropped (network blip, server disconnect; the detail carries the cause, e.g. `read ECONNRESET`)            | Usually retryable; check network/proxy if it repeats                                                                                                 |
| `stream_resume_unsafe_partial_tool_use` | The stream broke mid tool-call, leaving a partial argument that cannot be resumed or replayed safely                        | The turn aborts; start a new request                                                                                                                 |
| `provider_sticky_violation`             | Provider cannot switch while a tool call is in flight (sticky protection)                                                   | Switch models after the turn ends                                                                                                                    |
| `runner_error`                          | Catch-all for turn execution failures (the detail is the original error, e.g. a model that lacks vision receiving an image) | Fix the input or config per the detail                                                                                                               |
| `internal_error`                        | Fallback code for `--json` output mode                                                                                      | Check the full logs                                                                                                                                  |
| `builtin_hook_error`                    | A builtin plugin hook threw (mapped to `error.raised` by the composition layer)                                             | Inspect the plugin named in the detail                                                                                                               |
| `builtin_hook_timeout`                  | A builtin plugin hook timed out                                                                                             | Check the plugin for blocking work                                                                                                                   |
| `builtin_hook_payload_too_large`        | A hook payload exceeded the cap and was vetoed                                                                              | Reduce the data passed to the hook                                                                                                                   |

Other `error.raised`-adjacent codes (`all_providers_cooling_down` etc.) are listed in
the domain tables below.

## Provider / router / context

| code                                            | description                                                                             |
| ----------------------------------------------- | --------------------------------------------------------------------------------------- |
| `all_providers_cooling_down`                    | Every candidate provider is in a cooldown window (circuit breaker)                      |
| `cost_router_explicit_model_unpriced`           | The explicitly requested model has no pricing data for cost routing                     |
| `cost_router_no_affordable_route`               | No route fits the cost budget                                                           |
| `cost_router_pricing_missing`                   | Cost routing is missing pricing data                                                    |
| `cost_router_routes_empty`                      | The cost router's route table is empty                                                  |
| `cost_router_usage_estimate_missing`            | Cost routing is missing a usage estimate                                                |
| `fallback_chain_empty`                          | The fallback chain is empty                                                             |
| `fallback_provider_duplicate`                   | A provider appears twice in the fallback chain                                          |
| `ollama_endpoint_invalid`                       | Invalid Ollama endpoint                                                                 |
| `ollama_endpoint_protocol_not_supported`        | Ollama endpoint protocol not supported (HTTP(S) only)                                   |
| `ollama_endpoint_query_or_fragment_forbidden`   | Ollama endpoint must not carry a query/fragment                                         |
| `ollama_endpoint_userinfo_forbidden`            | Ollama endpoint must not carry userinfo                                                 |
| `ollama_redirect_denied`                        | Redirects from an Ollama endpoint are not followed (security policy)                    |
| `ollama_redirect_target_changed`                | The redirect target differs from the approved endpoint                                  |
| `ollama_remote_endpoint_confirmation_required`  | A non-loopback Ollama endpoint requires interactive danger confirmation                 |
| `ollama_remote_endpoint_non_interactive_denied` | Non-loopback Ollama endpoints are refused in non-interactive mode                       |
| `plugin_provider_cannot_be_default_v1`          | Under the v1 contract a plugin provider cannot be the default                           |
| `provider_capabilities_mismatch`                | Provider capabilities don't match the request (e.g. an image sent to a text-only model) |
| `provider_name_conflict`                        | Provider name collision                                                                 |
| `provider_not_in_fallback_chain`                | The requested provider is not in the fallback chain                                     |
| `provider_not_registered`                       | The provider is not registered                                                          |
| `reflection_model_unavailable`                  | The reflection model router had no available model (§21)                                |
| `reflection_model_error`                        | The reflection model call failed mid-stream (§21)                                       |
| `reflection_output_invalid`                     | The reflection output failed contract validation (nothing injected or stored, §21)      |
| `role_router_candidates_empty`                  | The role router has no candidates                                                       |
| `role_router_config_invalid`                    | Invalid role router config                                                              |
| `role_router_default_missing`                   | The role router has no default entry                                                    |
| `role_router_priority_invalid`                  | Invalid role router priority                                                            |
| `role_router_role_unknown`                      | The role router met an unknown role                                                     |
| `role_router_roles_invalid`                     | Invalid roles config for the role router                                                |
| `role_router_route_invalid`                     | Invalid role router entry                                                               |
| `router_budget_exhausted`                       | The router's budget is exhausted                                                        |
| `router_route_not_eligible`                     | A route entry does not satisfy the current conditions                                   |
| `semantic_embedding_count_mismatch`             | Semantic index vector count does not match entry count                                  |
| `semantic_embedding_unconfigured`               | Semantic index has no embedding configured                                              |
| `semantic_index_invalid`                        | Invalid semantic index                                                                  |
| `sticky_provider_not_in_fallback_chain`         | The sticky provider is not in the fallback chain                                        |
| `sticky_provider_not_in_role_candidates`        | The sticky provider is not among the role candidates                                    |
| `stream_resume_invalid`                         | Invalid stream resume state                                                             |
| `stream_resume_unsupported`                     | The provider does not support stream resume                                             |
| `stream_truncated`                              | The provider stream buffer limit was exceeded and the stream truncated                  |

## Plugins and hooks

| code                                     | description                                                                                        |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `hook_dispatch_timeout`                  | Hook dispatch timed out                                                                            |
| `hook_skipped`                           | Hook was skipped fail-open (a signal, not a fault)                                                 |
| `hook_priority_out_of_range`             | Hook priority out of range (contract code; the implementation uses `plugin_hook_priority_invalid`) |
| `plugin_activation_cancelled`            | Plugin activation was cancelled                                                                    |
| `plugin_activation_timeout`              | Plugin activation timed out                                                                        |
| `plugin_already_loaded`                  | The plugin is already loaded; duplicate load refused                                               |
| `plugin_approval_stale`                  | The plugin approval is stale                                                                       |
| `plugin_approval_required`               | The plugin requires approval before enabling                                                       |
| `plugin_auth_template_invalid`           | Invalid plugin auth template                                                                       |
| `plugin_bridge_closed`                   | The dev plugin fd3 bridge closed                                                                   |
| `plugin_bridge_frame_too_large`          | A plugin bridge frame exceeded the size cap                                                        |
| `plugin_bridge_invalid_json`             | A plugin bridge frame is not valid JSON                                                            |
| `plugin_bridge_no_handler`               | No handler for the plugin bridge call                                                              |
| `plugin_bridge_protocol`                 | Plugin bridge protocol violation                                                                   |
| `plugin_bridge_remote`                   | Remote error from the plugin bridge                                                                |
| `plugin_bridge_timeout`                  | Plugin bridge timed out                                                                            |
| `plugin_status_tab_invalid`              | Invalid plugin status tab definition                                                               |
| `plugin_status_section_invalid`          | Invalid plugin status section definition                                                           |
| `plugin_callback_cancelled`              | A plugin callback was cancelled                                                                    |
| `plugin_callback_failed`                 | A plugin callback failed                                                                           |
| `plugin_callback_timeout`                | A plugin callback timed out                                                                        |
| `plugin_command_invalid`                 | Plugin command registration failed spec validation                                                 |
| `plugin_command_target_required`         | Plugin command is missing its target                                                               |
| `plugin_command_unknown`                 | Unknown plugin command                                                                             |
| `plugin_config_undeclared`               | A config key was used that the plugin manifest does not declare                                    |
| `plugin_deactivated`                     | The plugin is deactivated                                                                          |
| `plugin_engine_incompatible`             | The plugin's engine version is incompatible                                                        |
| `plugin_exec_denied`                     | Plugin subprocess execution denied by permissions                                                  |
| `plugin_fs_denied`                       | Plugin file access denied by permissions                                                           |
| `plugin_heartbeat_timeout`               | Plugin host heartbeat timed out                                                                    |
| `plugin_hook_kv_quota_exceeded`          | Hook KV store quota exceeded                                                                       |
| `plugin_hook_priority_invalid`           | Invalid hook priority                                                                              |
| `plugin_hook_timeout`                    | Hook execution timed out                                                                           |
| `plugin_host_exited`                     | The plugin host process exited                                                                     |
| `plugin_integrity_failed`                | Plugin integrity check failed                                                                      |
| `plugin_lifecycle_authority_mismatch`    | The caller may not perform this plugin lifecycle operation                                         |
| `plugin_integration_unavailable`         | The plugin integration capability is unavailable                                                   |
| `plugin_internal_error`                  | Catch-all for plugin RPC failures                                                                  |
| `plugin_legacy_activation_unavailable`   | The legacy activation path is unavailable                                                          |
| `plugin_manifest_invalid`                | Invalid plugin manifest                                                                            |
| `plugin_memory_hook_dispatch_required`   | A memory hook is missing its required dispatch declaration                                         |
| `plugin_memory_hook_scope_required`      | A memory hook is missing its scope                                                                 |
| `plugin_memory_scope_denied`             | Memory scope access denied                                                                         |
| `plugin_memory_unavailable`              | The memory service is unavailable                                                                  |
| `plugin_memory_write_denied`             | Memory write denied                                                                                |
| `plugin_net_denied`                      | Plugin network access denied by permissions                                                        |
| `plugin_not_enabled` / `plugin_disabled` | Plugin not enabled / disabled                                                                      |
| `plugin_not_installed`                   | Plugin not installed                                                                               |
| `plugin_path_escape`                     | Plugin path escapes the allowed directories                                                        |
| `plugin_permission_denied`               | Plugin permission denied                                                                           |
| `plugin_provider_invalid`                | Invalid plugin provider definition                                                                 |
| `plugin_provider_net_required`           | The plugin provider needs network access it doesn't have                                           |
| `plugin_provider_permission_required`    | The plugin provider needs an additional permission                                                 |
| `plugin_rpc_frame_too_large`             | Plugin RPC frame exceeded the size cap                                                             |
| `plugin_rpc_invalid_json`                | Plugin RPC frame is not valid JSON                                                                 |
| `plugin_rpc_method_denied`               | Plugin RPC method denied (not allowlisted)                                                         |
| `plugin_rpc_params_invalid`              | Invalid plugin RPC params                                                                          |
| `plugin_rpc_quota_exceeded`              | Plugin RPC quota exceeded                                                                          |
| `plugin_rpc_transport_only`              | This RPC method is transport-internal only                                                         |
| `plugin_rpc_version`                     | Plugin RPC version mismatch                                                                        |
| `plugin_state_invalid`                   | Invalid plugin persisted state                                                                     |
| `plugin_symlink_rejected`                | The plugin directory contains a rejected symlink                                                   |
| `plugin_ui_invalid`                      | Invalid plugin UI definition                                                                       |
| `plugin_ui_permission_required`          | The plugin UI capability requires authorization                                                    |

## Market and plugin management

The `volund plugins` / marketplace domain:

| code                                 | description                                                                |
| ------------------------------------ | -------------------------------------------------------------------------- |
| `mcp_add_invalid`                    | Invalid MCP server add arguments                                           |
| `mcp_add_failed`                     | Adding the MCP server failed                                               |
| `mcp_action_failed`                  | MCP server action failed                                                   |
| `skill_command_failed`               | Skill command failed                                                       |
| `plugins_action_failed`              | Plugin management action failed                                            |
| `plugin_tool_invalid`                | Invalid plugin tool definition                                             |
| `plugin_web_search_invalid`          | Invalid WebSearch provider registration (missing id or search callback)    |
| `plugin_hook_invalid`                | Invalid plugin hook definition                                             |
| `plugin_prompt_invalid`              | Invalid plugin prompt definition                                           |
| `plugin_market_fetch_failed`         | Fetching a marketplace source failed (network / unreachable)               |
| `plugin_market_index_invalid`        | Invalid marketplace index                                                  |
| `plugin_market_metadata_invalid`     | Invalid marketplace entry metadata                                         |
| `plugin_market_source_invalid`       | Invalid marketplace source config                                          |
| `plugin_market_source_pollution`     | Marketplace source tampered (response fingerprint mismatch)                |
| `plugin_registry_digest_mismatch`    | Registry digest mismatch                                                   |
| `plugin_registry_metadata_invalid`   | Invalid registry metadata                                                  |
| `plugin_registry_revoked`            | The entry has been revoked                                                 |
| `plugin_registry_signature_invalid`  | Registry signature verification failed                                     |
| `plugin_registry_signature_required` | The registry is missing a required signature                               |
| `plugin_registry_source_invalid`     | Invalid registry source                                                    |
| `plugin_registry_source_pollution`   | Registry source tampered                                                   |
| `plugin_signing_approval_required`   | The plugin signing operation requires approval                             |
| `plugin_signing_credentials_missing` | Signing credentials are missing                                            |
| `plugin_archive_invalid`             | Invalid `.volund` archive (missing EOCD / corrupt directory / no manifest) |
| `plugin_archive_unsafe_entry`        | Archive entry name escapes the target directory (zip-slip)                 |
| `plugin_archive_unsupported_method`  | Archive uses a compression method other than store                         |
| `plugin_target_exists`               | Scaffold target directory is not empty (`plugins crate`)                   |

## Scheduled tasks

The `volund tasks` / `volund daemon` domain (see the [scheduled tasks guide](../guides/scheduled-tasks.md)):

| code                      | description                                                                                             |
| ------------------------- | ------------------------------------------------------------------------------------------------------- |
| `tasks_disabled`          | The scheduler is disabled (`[tasks].enabled` is not `true`)                                             |
| `task_daemon_running`     | Another daemon (with a live pid) already holds the scheduling lock                                      |
| `task_definition_invalid` | Task definition rejected by validation (`TaskStore.upsertTask` arguments)                               |
| `task_io`                 | Task store lock timeout / storage transaction IO error                                                  |
| `task_run_failed`         | A task run failed (spawn failure / timeout kill / non-zero exit / daemon interrupt)                     |
| `task_store_corrupt`      | Task store snapshot and recovery backup are both unreadable                                             |
| `task_config_drift`       | Run refused: the user-level config.toml hash (`[tasks]` excluded) differs from the frozen value (F1-03) |
| `task_trust_missing`      | Run refused: the task's frozen working directory is no longer trusted (F1-03)                           |

## Evolution local storage

Self-evolution records/journal (packages/storage):

| code                                    | description                                             |
| --------------------------------------- | ------------------------------------------------------- |
| `evolution_namespace_apply_unsupported` | The storage backend does not support apply-by-namespace |
| `evolution_record_continuity`           | The record chain is not continuous                      |
| `evolution_record_cross_constraint`     | The record violates a cross-entry constraint            |
| `evolution_record_future_schema`        | The record's schema version is from a newer writer      |
| `evolution_record_invalid`              | Invalid record                                          |
| `evolution_record_line_too_large`       | A single record exceeds the size limit                  |
| `evolution_record_sequence_regression`  | Record sequence number regressed                        |
| `evolution_record_time_regression`      | Record timestamp regressed                              |
| `evolution_journal_recovery_aborted`    | Journal recovery was aborted                            |
| `evolution_journal_recovery_completed`  | Journal recovery completed (a signal)                   |
| `evolution_journal_recovery_required`   | The journal needs recovery                              |
| `evolution_lock_stolen`                 | The storage lock was stolen                             |

## Memory

| code                          | description                                 |
| ----------------------------- | ------------------------------------------- |
| `memory_conflict`             | Memory write conflict                       |
| `memory_corrupt`              | Memory data corrupted                       |
| `memory_hook_failed`          | A memory hook failed                        |
| `memory_hook_reentrant`       | Re-entrant memory hook refused              |
| `memory_hook_veto`            | A memory hook vetoed the operation          |
| `memory_index_busy`           | The memory index is busy                    |
| `memory_index_corrupt`        | The memory index snapshot is corrupted      |
| `memory_index_unavailable`    | The memory index is unavailable             |
| `memory_io`                   | Memory read/write IO error                  |
| `memory_not_found`            | The target memory does not exist            |
| `memory_scope_denied`         | Memory scope access denied                  |
| `memory_transfer_unavailable` | The memory transfer capability is not wired |
| `memory_unknown`              | Unclassified memory error (fallback)        |
| `memory_validation`           | Memory data validation failed               |

## CLI / config / sessions

The `volund` CLI and its `--json` error protocol (`reason.code`):

| code                               | description                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------- |
| `config_invalid`                   | Invalid config file                                                                   |
| `config_project_forbidden`         | A project-level config wrote a key that is not allowed there                          |
| `config_unavailable`               | Config could not be read                                                              |
| `config_unknown_key`               | Unknown config key                                                                    |
| `current_model_source_unavailable` | Current model source info is unavailable                                              |
| `directory_untrusted`              | The directory is not on the trusted list (trust gate)                                 |
| `filesystem_isolation_unavailable` | The filesystem isolation mechanism is unavailable                                     |
| `invalid_workspace`                | Invalid workspace                                                                     |
| `mcp_list_failed`                  | Failed to list MCP servers                                                            |
| `mcp_port_unavailable`             | The MCP port is unavailable                                                           |
| `plugin_http_not_connected`        | The plugin HTTP channel is not connected                                              |
| `plugin_ui_not_connected`          | The plugin UI channel is not connected                                                |
| `prompt_required`                  | Missing prompt input                                                                  |
| `proxy_alpn_not_h2`                | The proxy tunnel's ALPN did not negotiate h2                                          |
| `proxy_tunnel_aborted`             | The proxy CONNECT tunnel was aborted                                                  |
| `proxy_tunnel_closed`              | The proxy CONNECT tunnel closed before it was established                             |
| `proxy_tunnel_failed`              | Establishing the proxy tunnel failed                                                  |
| `proxy_tunnel_rejected`            | The proxy refused the CONNECT request                                                 |
| `sandbox_network_blocked`          | Network access blocked inside the sandbox                                             |
| `sandbox_unavailable`              | The sandbox mechanism is unavailable                                                  |
| `session_id_invalid`               | Invalid session id                                                                    |
| `session_id_required`              | Missing session id                                                                    |
| `session_not_found`                | Session not found                                                                     |
| `session_resume_failed`            | Session resume failed                                                                 |
| `session_turn_in_progress`         | The session already has a turn in flight (turn mutex; the web layer maps this to 409) |

## Web console

The embedded web server (packages/web-server) domain:

| code                          | description                                                                          |
| ----------------------------- | ------------------------------------------------------------------------------------ |
| `web_origin_rejected`         | Host/Origin does not belong to this loopback server (CSRF line)                      |
| `web_session_invalid`         | Browser session missing / expired / nonce already used                               |
| `web_csrf_invalid`            | A mutating request is missing the CSRF header or it does not match                   |
| `web_schema_invalid`          | Unknown endpoint or invalid JSON body                                                |
| `web_capability_unavailable`  | Capability not wired (honest degradation)                                            |
| `web_attachment_rejected`     | Attachment type/size/magic-byte validation failed, or no active session              |
| `web_attachment_not_found`    | The attachment handle does not exist or was cleaned up                               |
| `web_state_conflict`          | In embedded mode the session is owned by the TUI; the web-side operation was refused |
| `web_session_group_not_found` | The sidebar session group id does not exist                                          |
| `trust_store_unavailable`     | The trust store is unavailable                                                       |
| `unsupported_flag`            | Unsupported startup flag                                                             |

## Remote gateway

packages/gateway-server domain (HTTP status mapping in parentheses):

| code                           | description                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `gateway_auth_invalid`         | Bearer token missing / expired / bad signature (401)                                                    |
| `gateway_client_rejected`      | OAuth client credentials are wrong (401)                                                                |
| `gateway_grant_unsupported`    | Unsupported grant_type (400)                                                                            |
| `gateway_rate_limited`         | Per-client / per-IP rate limit hit (429)                                                                |
| `gateway_schema_invalid`       | Malformed body/frame or unknown endpoint (400/404)                                                      |
| `gateway_session_busy`         | The session runner is busy or queue wait timed out (409)                                                |
| `gateway_session_not_found`    | Session does not exist or cannot be resumed (404)                                                       |
| `gateway_unsupported_content`  | The chat carried an unsupported multimodal part (400)                                                   |
| `gateway_upstream_failed`      | Runner/assembly-side failure (502)                                                                      |
| `gateway_ws_protocol_error`    | WS frame is not JSON / missing type / unknown type                                                      |
| `gateway_uplink_offline`       | This machine is not dialed in, or the tunnel dropped (503)                                              |
| `gateway_pairing_invalid`      | Pairing code missing / expired / already redeemed (400)                                                 |
| `gateway_static_missing`       | Mobile site static assets are missing (404)                                                             |
| `gateway_attachment_not_found` | The attachment handle does not exist / was cleaned up (404)                                             |
| `gateway_enrollment_disabled`  | Dynamic enrollment is disabled by policy (403)                                                          |
| `remote_cwd_invalid`           | The uplink RPC's cwd does not exist or escapes the local workspace (400)                                |
| `remote_hub_failed`            | The local hub RPC failed (relayed through the tunnel)                                                   |
| `permission_timeout`           | Model-facing tool result when an approval card times out and is auto-denied                             |
| `ask_timeout`                  | Model-facing tool result when a question card times out and is auto-closed                              |
| `mcp_fatigue_rate_limited`     | Model-facing tool result when an MCP server's approval prompts exceed its per-minute rate (auto-denied) |
| `mcp_tool_unapproved`          | Model-facing tool result when an MCP server's tool set changed without re-approval (trust gate)         |

::: tip Approval and question cards
Permission approval cards are **auto-denied after 120 seconds** without a
decision, and question (ask) cards are **auto-closed** on the same clock when
unanswered — this is the core approval queue's built-in fallback (identical
across the TUI, Web console, mobile, and line-mode prompts). Gateway scenarios
are additionally governed by `GATEWAY_PERMISSION_TIMEOUT_MS`, and both can be
adjusted with the user-level config `[permissions] request_timeout_ms`
(milliseconds; set it to `0` to disable the fallback). The model then sees
`permission_timeout: <tool> approval timed out …` or `ask_timeout: …` as the
tool result — that means "nobody answered in time", not "permissions are
misconfigured". If remote tasks keep stalling, check whether anyone answered
the card.
:::

## UI (themes / slash commands)

| code                             | description                                    |
| -------------------------------- | ---------------------------------------------- |
| `slash_command_builtin_reserved` | The slash command name collides with a builtin |
| `slash_command_conflict`         | The slash command name is already registered   |
| `slash_command_invalid_name`     | Invalid slash command name                     |
| `theme_invalid`                  | Invalid theme definition                       |
| `theme_invalid_json`             | The theme file is not valid JSON               |
| `theme_version_unsupported`      | Unsupported theme version                      |

## Transport protocol (`VOLUND_*` constants)

gRPC-style constant codes for RPC/transport:

| code                                     | description                             |
| ---------------------------------------- | --------------------------------------- |
| `VOLUND_INVALID_CWD`                     | Invalid cwd                             |
| `VOLUND_INVALID_REQUEST`                 | Invalid request                         |
| `VOLUND_METHOD_NOT_FOUND`                | RPC method not found                    |
| `VOLUND_PROTOCOL_INVALID`                | Protocol violation                      |
| `VOLUND_RESOURCE_EXHAUSTED`              | Resource exhausted                      |
| `VOLUND_SUBAGENT_BUDGET_EXCEEDS_DEFAULT` | Subagent budget exceeds the default cap |
| `VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED`   | Subagent concurrency exceeded           |
| `VOLUND_SUBAGENT_DEPTH_EXCEEDED`         | Subagent nesting depth exceeded         |
| `VOLUND_SUBAGENT_FAILED`                 | Subagent execution failed               |
| `VOLUND_SUBAGENT_UNKNOWN_AGENT`          | Reference to an undefined subagent type |
| `VOLUND_UNSAFE_CWD`                      | Unsafe cwd (trust gate)                 |
| `VOLUND_UNSUPPORTED_VERSION`             | Unsupported protocol version            |

## Normalized codes (`VOLUND_<CATEGORY>`)

Unknown errors from providers/tools/MCP/plugins are normalized by `normalizeError`
into a `VOLUND_<CATEGORY>` code while keeping the upstream message:

| code                        | category                                       |
| --------------------------- | ---------------------------------------------- |
| `VOLUND_NETWORK`            | Network error (retryable)                      |
| `VOLUND_AUTH`               | Authentication failed (check the API key)      |
| `VOLUND_RATE_LIMIT`         | Upstream rate limited (carries retryAfterMs)   |
| `VOLUND_QUOTA`              | Quota exhausted                                |
| `VOLUND_INVALID_REQUEST`    | The upstream rejected the request parameters   |
| `VOLUND_CONTENT_FILTER`     | Content blocked by the upstream safety policy  |
| `VOLUND_MODEL_NOT_FOUND`    | Model name does not exist or is not accessible |
| `VOLUND_SERVER`             | Upstream server error (5xx, retryable)         |
| `VOLUND_CONTEXT_LENGTH`     | Context length exceeded (compact the session)  |
| `VOLUND_STREAM_TRUNCATED`   | Stream truncated                               |
| `VOLUND_PROTOCOL`           | Upstream protocol violation                    |
| `VOLUND_PERMISSION`         | Insufficient permission                        |
| `VOLUND_SANDBOX`            | Sandbox-related error                          |
| `VOLUND_TIMEOUT`            | Timed out                                      |
| `VOLUND_CANCELLED`          | Operation cancelled                            |
| `VOLUND_RESOURCE_EXHAUSTED` | Resource exhausted                             |
| `VOLUND_UNKNOWN`            | Unclassified (fallback)                        |

## Native workers (reserved)

Registered for the native worker pools but not emitted yet — the pools currently
degrade via restart counters instead of surfacing these codes:

| code                    | description                                       |
| ----------------------- | ------------------------------------------------- |
| `search_worker_crashed` | The search worker pool lost a worker (B.2 §5.6.1) |
| `fs_worker_crashed`     | The fs worker pool lost a worker (B.2 §5.8)       |

## Test infrastructure

Ships with `@volund/testkit`; you should only meet these in tests:

| code                                              | description                                             |
| ------------------------------------------------- | ------------------------------------------------------- |
| `mock_provider_disposed`                          | A disposed mock provider was used again                 |
| `mock_provider_script_exhausted`                  | The mock provider's script ran out                      |
| `testkit_injection_requires_non_negative_integer` | Injection parameter must be a non-negative integer      |
| `testkit_path_escape`                             | Testkit path escape                                     |
| `testkit_truncate_utf8_requires_surrogate_pair`   | UTF-8 truncation must land on a surrogate pair boundary |
| `toml_unsupported_number`                         | TOML does not support this number literal               |
| `toml_unsupported_type`                           | TOML does not support this type                         |
