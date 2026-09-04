/**
 * 错误码集中登记表（REM-59 / r13-I3）。
 *
 * 契约来源：docs/superpowers/specs/2026-07-31-volund-code-design/APPENDIX-B-error-codes.md。
 * `error.raised` 的 `code` 是跨模块契约（core emit → ui 渲染 → telemetry 分类 → 用户 grep），
 * 其余跨模块错误标识（PluginError / MemoryError / VolundError / ProtocolViolationError /
 * VolundNormalizedError / CLI `--json` 错误协议的 `reason.code`）同表登记，唯一真相源在此。
 *
 * 强制方式：oxlint 无"属性值 / 构造实参必须引用常量"类规则，裸字符串码由
 * `pnpm verify:error-codes`（scripts/verify-error-codes.mjs，挂在根 `pnpm test` 链）承担：
 * - 源码 emit 的字面量码 ∉ 本表 → CI fail（新增码必须先登记）；
 * - 附录 B.2 的契约码 ∉ 本表 → CI fail；
 * - 本表条目无任何 emit 且不在脚本豁免清单（附来源注释）→ CI fail（防僵尸条目）。
 *
 * 维护规则：新码先入表（带来源注释）再写 emit；条目按分组内字母序，值全局唯一。
 * 附录 B 末注的实现历史码已并入本表（union），与 B.2 的差异在 REM-59 PR 中列明，
 * 待 spec 修订收编。
 */

export const ErrorCodes = {
  /* ── error.raised 契约码（附录 B.2）＋ runner 实现码 ───────────────────── */
  toolLoopExhausted: 'tool_loop_exhausted', // B.2 §2.4 B2（packages/core/src/runner.ts）
  streamInterrupted: 'stream_interrupted', // B.2 §2.4 B6 / §3.9a（runner.ts）
  providerStickyViolation: 'provider_sticky_violation', // B.2 §2.4 B4 / §3.7.1（runner.ts）
  subagentBudgetExhausted: 'subagent_budget_exhausted', // B.2 §2.7（runner.ts）
  streamResumeUnsafePartialToolUse: 'stream_resume_unsafe_partial_tool_use', // 历史码（runner.ts，附录 B 末注待收编）
  runnerError: 'runner_error', // runner.ts 顶层 catch
  internalError: 'internal_error', // machine-output.ts `--json` error 兜底码

  /* ── 附录 B.2 契约码 ─────────────────────────────────────────────────── */
  builtinHookPayloadTooLarge: 'builtin_hook_payload_too_large', // B.2 §2.6 / §18 SD0-02（超限 builtin payload direct-veto）
  builtinHookTimeout: 'builtin_hook_timeout', // B.2 §2.6 r13-I10（plugin-runtime hook pipeline 信号，组合层映射 error.raised）
  hookPriorityOutOfRange: 'hook_priority_out_of_range', // B.2 §6.11.1（实现未接线，预留；现用 plugin_hook_priority_invalid）
  searchWorkerCrashed: 'search_worker_crashed', // B.2 §5.6.1 / §5.8（worker-pool 现以 restart 计数降级，未 emit 码，预留）
  fsWorkerCrashed: 'fs_worker_crashed', // B.2 §5.8（同上，预留）

  /* ── provider / router / context 域 ──────────────────────────────────── */
  allProvidersCoolingDown: 'all_providers_cooling_down',
  costRouterExplicitModelUnpriced: 'cost_router_explicit_model_unpriced',
  costRouterNoAffordableRoute: 'cost_router_no_affordable_route',
  costRouterPricingMissing: 'cost_router_pricing_missing',
  costRouterRoutesEmpty: 'cost_router_routes_empty',
  costRouterUsageEstimateMissing: 'cost_router_usage_estimate_missing',
  fallbackChainEmpty: 'fallback_chain_empty',
  fallbackProviderDuplicate: 'fallback_provider_duplicate',
  ollamaEndpointInvalid: 'ollama_endpoint_invalid',
  ollamaEndpointProtocolNotSupported: 'ollama_endpoint_protocol_not_supported',
  ollamaEndpointQueryOrFragmentForbidden: 'ollama_endpoint_query_or_fragment_forbidden',
  ollamaEndpointUserinfoForbidden: 'ollama_endpoint_userinfo_forbidden',
  ollamaRedirectDenied: 'ollama_redirect_denied',
  ollamaRedirectTargetChanged: 'ollama_redirect_target_changed',
  ollamaRemoteEndpointConfirmationRequired: 'ollama_remote_endpoint_confirmation_required',
  ollamaRemoteEndpointNonInteractiveDenied: 'ollama_remote_endpoint_non_interactive_denied',
  pluginProviderCannotBeDefaultV1: 'plugin_provider_cannot_be_default_v1',
  providerCapabilitiesMismatch: 'provider_capabilities_mismatch',
  providerNameConflict: 'provider_name_conflict', // B.2 PLUGIN-PROVIDER-r1 §P5（provider-kit）
  providerNotInFallbackChain: 'provider_not_in_fallback_chain',
  providerNotRegistered: 'provider_not_registered',
  roleRouterCandidatesEmpty: 'role_router_candidates_empty',
  roleRouterConfigInvalid: 'role_router_config_invalid',
  roleRouterDefaultMissing: 'role_router_default_missing',
  roleRouterPriorityInvalid: 'role_router_priority_invalid',
  roleRouterRoleUnknown: 'role_router_role_unknown',
  roleRouterRolesInvalid: 'role_router_roles_invalid',
  roleRouterRouteInvalid: 'role_router_route_invalid',
  routerBudgetExhausted: 'router_budget_exhausted',
  routerRouteNotEligible: 'router_route_not_eligible',
  semanticEmbeddingCountMismatch: 'semantic_embedding_count_mismatch',
  semanticEmbeddingUnconfigured: 'semantic_embedding_unconfigured',
  semanticIndexInvalid: 'semantic_index_invalid',
  stickyProviderNotInFallbackChain: 'sticky_provider_not_in_fallback_chain',
  stickyProviderNotInRoleCandidates: 'sticky_provider_not_in_role_candidates',
  streamResumeInvalid: 'stream_resume_invalid',
  streamResumeUnsupported: 'stream_resume_unsupported', // B.2 §3.9a r13-D1（provider-kit）
  streamTruncated: 'stream_truncated', // plugin-runtime provider stream buffer exceeded

  /* ── plugin 域（PluginError / HookPipelineSignal，packages/plugin-runtime） */
  builtinHookError: 'builtin_hook_error', // builtin 域 hook 抛错（组合层映射 error.raised）
  hookDispatchTimeout: 'hook_dispatch_timeout', // hook 分发超时（PluginError）
  hookSkipped: 'hook_skipped', // hook fail-open 跳过信号
  pluginActivationCancelled: 'plugin_activation_cancelled',
  pluginActivationTimeout: 'plugin_activation_timeout',
  pluginAlreadyLoaded: 'plugin_already_loaded',
  pluginApprovalStale: 'plugin_approval_stale',
  pluginApprovalRequired: 'plugin_approval_required',
  pluginAuthTemplateInvalid: 'plugin_auth_template_invalid',
  pluginBridgeClosed: 'plugin_bridge_closed', // PLUGIN-STATUS-UI-r1 dev 装载（fd3 桥）
  pluginBridgeFrameTooLarge: 'plugin_bridge_frame_too_large',
  pluginBridgeInvalidJson: 'plugin_bridge_invalid_json',
  pluginBridgeNoHandler: 'plugin_bridge_no_handler',
  pluginBridgeProtocol: 'plugin_bridge_protocol',
  pluginBridgeRemote: 'plugin_bridge_remote',
  pluginBridgeTimeout: 'plugin_bridge_timeout',
  pluginStatusTabInvalid: 'plugin_status_tab_invalid',
  pluginStatusSectionInvalid: 'plugin_status_section_invalid',
  pluginCallbackCancelled: 'plugin_callback_cancelled',
  pluginCallbackFailed: 'plugin_callback_failed',
  pluginCallbackTimeout: 'plugin_callback_timeout',
  pluginCommandInvalid: 'plugin_command_invalid', // commands.register spec 校验（本地插件通道）
  pluginCommandTargetRequired: 'plugin_command_target_required',
  pluginCommandUnknown: 'plugin_command_unknown',
  pluginConfigUndeclared: 'plugin_config_undeclared',
  pluginDeactivated: 'plugin_deactivated',
  pluginEngineIncompatible: 'plugin_engine_incompatible',
  pluginExecDenied: 'plugin_exec_denied',
  pluginFsDenied: 'plugin_fs_denied',
  pluginHeartbeatTimeout: 'plugin_heartbeat_timeout',
  pluginHookKvQuotaExceeded: 'plugin_hook_kv_quota_exceeded',
  pluginHookPriorityInvalid: 'plugin_hook_priority_invalid',
  pluginHookTimeout: 'plugin_hook_timeout',
  pluginHostExited: 'plugin_host_exited',
  pluginIntegrityFailed: 'plugin_integrity_failed',
  pluginLifecycleAuthorityMismatch: 'plugin_lifecycle_authority_mismatch',
  pluginIntegrationUnavailable: 'plugin_integration_unavailable',
  pluginInternalError: 'plugin_internal_error', // safeRpcError 兜底（非字面量 emit）
  pluginLegacyActivationUnavailable: 'plugin_legacy_activation_unavailable',
  pluginManifestInvalid: 'plugin_manifest_invalid',
  pluginMemoryHookDispatchRequired: 'plugin_memory_hook_dispatch_required',
  pluginMemoryHookScopeRequired: 'plugin_memory_hook_scope_required',
  pluginMemoryScopeDenied: 'plugin_memory_scope_denied',
  pluginMemoryUnavailable: 'plugin_memory_unavailable',
  pluginMemoryWriteDenied: 'plugin_memory_write_denied',
  pluginNetDenied: 'plugin_net_denied',
  pluginNotEnabled: 'plugin_not_enabled',
  pluginDisabled: 'plugin_disabled',
  pluginNotInstalled: 'plugin_not_installed',
  pluginPathEscape: 'plugin_path_escape',
  pluginPermissionDenied: 'plugin_permission_denied',
  pluginProviderInvalid: 'plugin_provider_invalid',
  pluginProviderNetRequired: 'plugin_provider_net_required',
  pluginProviderPermissionRequired: 'plugin_provider_permission_required',
  // PLUGIN-MANAGER：市场源装载诊断码（apps/cli plugin-market）
  mcpAddInvalid: 'mcp_add_invalid',
  mcpAddFailed: 'mcp_add_failed',
  mcpActionFailed: 'mcp_action_failed',
  skillCommandFailed: 'skill_command_failed',
  pluginsActionFailed: 'plugins_action_failed',
  pluginToolInvalid: 'plugin_tool_invalid',
  pluginHookInvalid: 'plugin_hook_invalid',
  pluginMarketFetchFailed: 'plugin_market_fetch_failed',
  pluginMarketIndexInvalid: 'plugin_market_index_invalid',
  pluginMarketMetadataInvalid: 'plugin_market_metadata_invalid',
  pluginMarketSourceInvalid: 'plugin_market_source_invalid',
  pluginMarketSourcePollution: 'plugin_market_source_pollution',
  pluginRegistryDigestMismatch: 'plugin_registry_digest_mismatch',
  pluginRegistryMetadataInvalid: 'plugin_registry_metadata_invalid',
  pluginRegistryRevoked: 'plugin_registry_revoked',
  pluginRegistrySignatureInvalid: 'plugin_registry_signature_invalid',
  pluginRegistrySignatureRequired: 'plugin_registry_signature_required',
  pluginRegistrySourceInvalid: 'plugin_registry_source_invalid',
  pluginRegistrySourcePollution: 'plugin_registry_source_pollution',
  pluginRpcFrameTooLarge: 'plugin_rpc_frame_too_large',
  pluginRpcInvalidJson: 'plugin_rpc_invalid_json',
  pluginRpcMethodDenied: 'plugin_rpc_method_denied',
  pluginRpcParamsInvalid: 'plugin_rpc_params_invalid',
  pluginRpcQuotaExceeded: 'plugin_rpc_quota_exceeded',
  pluginRpcTransportOnly: 'plugin_rpc_transport_only',
  pluginStateInvalid: 'plugin_state_invalid',
  pluginRpcVersion: 'plugin_rpc_version',
  pluginSigningApprovalRequired: 'plugin_signing_approval_required',
  pluginSigningCredentialsMissing: 'plugin_signing_credentials_missing',
  pluginSymlinkRejected: 'plugin_symlink_rejected',
  pluginUiInvalid: 'plugin_ui_invalid',
  pluginUiPermissionRequired: 'plugin_ui_permission_required',

  /* ── evolution 本地存储诊断码（packages/storage） ──────────────────── */
  evolutionNamespaceApplyUnsupported: 'evolution_namespace_apply_unsupported',
  evolutionRecordContinuity: 'evolution_record_continuity',
  evolutionRecordCrossConstraint: 'evolution_record_cross_constraint',
  evolutionRecordFutureSchema: 'evolution_record_future_schema',
  evolutionRecordInvalid: 'evolution_record_invalid',
  evolutionRecordLineTooLarge: 'evolution_record_line_too_large',
  evolutionRecordSequenceRegression: 'evolution_record_sequence_regression',
  evolutionRecordTimeRegression: 'evolution_record_time_regression',
  evolutionJournalRecoveryAborted: 'evolution_journal_recovery_aborted',
  evolutionJournalRecoveryCompleted: 'evolution_journal_recovery_completed',
  evolutionJournalRecoveryRequired: 'evolution_journal_recovery_required',
  evolutionLockStolen: 'evolution_lock_stolen',

  /* ── memory 域（MemoryError，packages/storage + ui 面板） ─────────────── */
  memoryConflict: 'memory_conflict',
  memoryCorrupt: 'memory_corrupt',
  memoryHookFailed: 'memory_hook_failed',
  memoryHookReentrant: 'memory_hook_reentrant',
  memoryHookVeto: 'memory_hook_veto',
  memoryIndexBusy: 'memory_index_busy',
  memoryIndexCorrupt: 'memory_index_corrupt', // memory-index.ts 快照读取三元缺省码
  memoryIndexUnavailable: 'memory_index_unavailable',
  memoryIo: 'memory_io',
  memoryNotFound: 'memory_not_found',
  memoryScopeDenied: 'memory_scope_denied',
  memoryUnknown: 'memory_unknown', // ui memoryPanelError 兜底
  memoryValidation: 'memory_validation',

  /* ── CLI `--json` 错误协议 / 状态 reason 码（apps/cli） ───────────────── */
  configInvalid: 'config_invalid',
  configProjectForbidden: 'config_project_forbidden',
  configUnavailable: 'config_unavailable',
  configUnknownKey: 'config_unknown_key',
  currentModelSourceUnavailable: 'current_model_source_unavailable',
  directoryUntrusted: 'directory_untrusted',
  filesystemIsolationUnavailable: 'filesystem_isolation_unavailable',
  invalidWorkspace: 'invalid_workspace',
  mcpListFailed: 'mcp_list_failed',
  mcpPortUnavailable: 'mcp_port_unavailable',
  pluginHttpNotConnected: 'plugin_http_not_connected',
  pluginUiNotConnected: 'plugin_ui_not_connected',
  promptRequired: 'prompt_required',
  proxyAlpnNotH2: 'proxy_alpn_not_h2',
  proxyTunnelAborted: 'proxy_tunnel_aborted',
  proxyTunnelFailed: 'proxy_tunnel_failed',
  proxyTunnelRejected: 'proxy_tunnel_rejected',
  sandboxNetworkBlocked: 'sandbox_network_blocked',
  sandboxUnavailable: 'sandbox_unavailable',
  sessionIdInvalid: 'session_id_invalid',
  sessionIdRequired: 'session_id_required',
  sessionNotFound: 'session_not_found',
  sessionResumeFailed: 'session_resume_failed',
  trustStoreUnavailable: 'trust_store_unavailable',
  unsupportedFlag: 'unsupported_flag',

  /* ── ui 域（主题 / 斜杠命令，packages/ui） ───────────────────────────── */
  slashCommandBuiltinReserved: 'slash_command_builtin_reserved',
  slashCommandConflict: 'slash_command_conflict',
  slashCommandInvalidName: 'slash_command_invalid_name',
  themeInvalid: 'theme_invalid',
  themeInvalidJson: 'theme_invalid_json',
  themeVersionUnsupported: 'theme_version_unsupported',

  /* ── VOLUND_* 传输 / 协议 / subagent 域（shared + subagent） ──────────── */
  volundInvalidCwd: 'VOLUND_INVALID_CWD',
  volundInvalidRequest: 'VOLUND_INVALID_REQUEST',
  volundMethodNotFound: 'VOLUND_METHOD_NOT_FOUND',
  volundProtocolInvalid: 'VOLUND_PROTOCOL_INVALID',
  volundResourceExhausted: 'VOLUND_RESOURCE_EXHAUSTED',
  volundSubagentConcurrencyExceeded: 'VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED', // resourceError() 实参
  volundSubagentDepthExceeded: 'VOLUND_SUBAGENT_DEPTH_EXCEEDED', // resourceError() 实参
  volundSubagentFailed: 'VOLUND_SUBAGENT_FAILED',
  volundSubagentUnknownAgent: 'VOLUND_SUBAGENT_UNKNOWN_AGENT', // SubagentDispatcher.dispatch 实参（§2.7.1 Task 校验）
  volundUnsafeCwd: 'VOLUND_UNSAFE_CWD',
  volundUnsupportedVersion: 'VOLUND_UNSUPPORTED_VERSION',

  /* ── VOLUND_<CATEGORY>：normalizeError 动态工厂输出（shared/errors.ts） ─ */
  volundAuth: 'VOLUND_AUTH',
  volundCancelled: 'VOLUND_CANCELLED',
  volundContentFilter: 'VOLUND_CONTENT_FILTER',
  volundContextLength: 'VOLUND_CONTEXT_LENGTH',
  volundModelNotFound: 'VOLUND_MODEL_NOT_FOUND',
  volundNetwork: 'VOLUND_NETWORK',
  volundPermission: 'VOLUND_PERMISSION',
  volundProtocol: 'VOLUND_PROTOCOL',
  volundQuota: 'VOLUND_QUOTA',
  volundRateLimit: 'VOLUND_RATE_LIMIT',
  volundSandbox: 'VOLUND_SANDBOX',
  volundServer: 'VOLUND_SERVER',
  volundStreamTruncated: 'VOLUND_STREAM_TRUNCATED',
  volundTimeout: 'VOLUND_TIMEOUT',
  volundUnknown: 'VOLUND_UNKNOWN',

  /* ── 测试基建（packages/testkit，随包发布、可向用户冒泡） ────────────── */
  mockProviderDisposed: 'mock_provider_disposed',
  mockProviderScriptExhausted: 'mock_provider_script_exhausted',
  testkitInjectionRequiresNonNegativeInteger: 'testkit_injection_requires_non_negative_integer',
  testkitPathEscape: 'testkit_path_escape',
  testkitTruncateUtf8RequiresSurrogatePair: 'testkit_truncate_utf8_requires_surrogate_pair',
  tomlUnsupportedNumber: 'toml_unsupported_number',
  tomlUnsupportedType: 'toml_unsupported_type',
} as const

/** 全部已登记错误码的联合类型；emit 处应引用 {@link ErrorCodes} 常量获得该收窄。 */
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes]

/**
 * 附录 B.2 登记表的 11 个契约码（`error.raised` 跨模块契约子集）。
 * scripts/verify-error-codes.mjs 会解析附录 B markdown 并双向校验本表。
 */
export const appendixErrorCodes = [
  'tool_loop_exhausted',
  'stream_interrupted',
  'provider_sticky_violation',
  'subagent_budget_exhausted',
  'builtin_hook_payload_too_large',
  'builtin_hook_timeout',
  'hook_priority_out_of_range',
  'provider_name_conflict',
  'search_worker_crashed',
  'fs_worker_crashed',
  'stream_resume_unsupported',
] as const satisfies readonly ErrorCode[]

/**
 * `normalizeError` 的 `VOLUND_${category.toUpperCase()}` 动态工厂全量输出
 * （VolundErrorCategory 全集 × 前缀；静态字面量扫描无法覆盖，登记于此供核对）。
 */
export const normalizedErrorCodes = [
  'VOLUND_NETWORK',
  'VOLUND_AUTH',
  'VOLUND_RATE_LIMIT',
  'VOLUND_QUOTA',
  'VOLUND_INVALID_REQUEST',
  'VOLUND_CONTENT_FILTER',
  'VOLUND_MODEL_NOT_FOUND',
  'VOLUND_SERVER',
  'VOLUND_CONTEXT_LENGTH',
  'VOLUND_STREAM_TRUNCATED',
  'VOLUND_PROTOCOL',
  'VOLUND_PERMISSION',
  'VOLUND_SANDBOX',
  'VOLUND_TIMEOUT',
  'VOLUND_CANCELLED',
  'VOLUND_RESOURCE_EXHAUSTED',
  'VOLUND_UNKNOWN',
] as const satisfies readonly ErrorCode[]

const ErrorCodeSet: ReadonlySet<string> = new Set(Object.values(ErrorCodes))

/** 未知值（JSON 输入、RPC frame、telemetry 标签）是否为已登记错误码。 */
export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && ErrorCodeSet.has(value)
}
