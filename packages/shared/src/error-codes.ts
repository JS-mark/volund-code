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
  pluginArchiveInvalid: 'plugin_archive_invalid', // .volund 容器（EOCD 缺失/目录损坏/缺 manifest）
  pluginArchiveUnsafeEntry: 'plugin_archive_unsafe_entry', // zip-slip：条目名逃逸目标目录
  pluginArchiveUnsupportedMethod: 'plugin_archive_unsupported_method', // 非 store 压缩条目
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
  pluginTargetExists: 'plugin_target_exists', // plugins crate：目标目录非空
  // PLUGIN-MANAGER：市场源装载诊断码（apps/cli plugin-market）
  mcpAddInvalid: 'mcp_add_invalid',
  mcpAddFailed: 'mcp_add_failed',
  mcpActionFailed: 'mcp_action_failed',
  skillCommandFailed: 'skill_command_failed',
  pluginsActionFailed: 'plugins_action_failed',
  pluginToolInvalid: 'plugin_tool_invalid',
  pluginWebSearchInvalid: 'plugin_web_search_invalid',
  pluginHookInvalid: 'plugin_hook_invalid',
  pluginPromptInvalid: 'plugin_prompt_invalid',
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
  memoryTransferUnavailable: 'memory_transfer_unavailable', // web 管理面 transfer 未装配（WEB-EXT-MANAGE-MARKET-r1）
  memoryUnknown: 'memory_unknown', // ui memoryPanelError 兜底
  memoryValidation: 'memory_validation',

  /* ── tasks 域（TaskError，packages/storage task-store + W-17 调度线） ─── */
  taskConfigDrift: 'task_config_drift', // daemon F1-03：运行前重算 config hash 与冻结值不一致，拒绝执行
  taskDaemonRunning: 'task_daemon_running', // volund daemon 单实例：另一 daemon（活 pid）持有调度权
  taskDefinitionInvalid: 'task_definition_invalid', // tasks-schema 校验拒绝（TaskStore.upsertTask 实参）
  taskIo: 'task_io', // task-store.ts 等锁超时 / 存储事务 IO
  taskNotFound: 'task_not_found', // cli/web.ts setEnabled 指定任务 id 不存在
  taskRunFailed: 'task_run_failed', // 任务运行失败（spawn 失败 / 超时击杀 / 非零退出 / daemon 中断）
  taskStoreCorrupt: 'task_store_corrupt', // task-store.ts 快照与恢复备份均不可读
  taskTrustMissing: 'task_trust_missing', // daemon F1-03：任务冻结 cwd 已不被信任，拒绝执行
  tasksDisabled: 'tasks_disabled', // [tasks].enabled=false（W-17 默认关闭）时 daemon 拒绝启动

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
  proxyTunnelClosed: 'proxy_tunnel_closed',
  proxyTunnelFailed: 'proxy_tunnel_failed',
  proxyTunnelRejected: 'proxy_tunnel_rejected',
  sandboxNetworkBlocked: 'sandbox_network_blocked',
  sandboxUnavailable: 'sandbox_unavailable',
  sessionIdInvalid: 'session_id_invalid',
  sessionIdRequired: 'session_id_required',
  sessionNotFound: 'session_not_found',
  sessionResumeFailed: 'session_resume_failed',
  sessionTurnInProgress: 'session_turn_in_progress', // §22 W-03 / Web P1-03（app-runtime SessionController turn mutex；Web 层映射 409 web_turn_in_progress）

  /* ── web 域（§22.8/§22.10，packages/web-server） ─────────────────────── */
  webOriginRejected: 'web_origin_rejected', // W-01/§22.10：Host/Origin 不属于 loopback server
  webSessionInvalid: 'web_session_invalid', // §22.10.1：browser session 缺失/过期/nonce 已用
  webCsrfInvalid: 'web_csrf_invalid', // §22.10.1：mutation 缺 CSRF 头或不匹配
  webSchemaInvalid: 'web_schema_invalid', // §22.8：未知端点/非法 JSON 体
  webCapabilityUnavailable: 'web_capability_unavailable', // §22.3.4：能力未接线（诚实降级）
  webAttachmentRejected: 'web_attachment_rejected', // §22 W-05：附件类型/大小/魔数校验失败或无活动会话
  webAttachmentNotFound: 'web_attachment_not_found', // §22 W-05：附件字节回放的 handle 不存在/已清理（404，packages/web-server/src/index.ts）
  webStateConflict: 'web_state_conflict', // §22 W-01/§22.9.2：嵌入式模式下会话所有权在 TUI，web 侧 start/resume 被拒
  webSessionGroupNotFound: 'web_session_group_not_found', // Web 侧栏会话分组：rename/delete/assign 指向的分组 id 不存在
  trustStoreUnavailable: 'trust_store_unavailable',
  unsupportedFlag: 'unsupported_flag',

  /* ── gateway 域（远程网关，packages/gateway-server；§GATEWAY-r1） ────────── */
  gatewayAuthInvalid: 'gateway_auth_invalid', // Bearer token 缺失/过期/签名不符（401）
  gatewayClientRejected: 'gateway_client_rejected', // /oauth/token 客户端凭证错误（401）
  gatewayGrantUnsupported: 'gateway_grant_unsupported', // grant_type ≠ client_credentials（400）
  gatewayRateLimited: 'gateway_rate_limited', // 每客户端/每 IP 每分钟限流（429）
  gatewaySchemaInvalid: 'gateway_schema_invalid', // body/帧形状非法、未知端点（400/404）
  gatewaySessionBusy: 'gateway_session_busy', // 单 runner 被占或队列等待超时（409）
  gatewaySessionNotFound: 'gateway_session_not_found', // session_id 不存在或不可恢复（404）
  gatewayUnsupportedContent: 'gateway_unsupported_content', // chat 多模态 part（400）
  gatewayUpstreamFailed: 'gateway_upstream_failed', // runner/装配侧失败（502）
  gatewayWsProtocolError: 'gateway_ws_protocol_error', // WS 帧非 JSON / 缺 type / 未知类型
  gatewayUplinkOffline: 'gateway_uplink_offline', // REM-r1 relay：本机未拨出注册/隧道断开（503）
  gatewayPairingInvalid: 'gateway_pairing_invalid', // REM-r1 配对码不存在/过期/已核销（400）
  gatewayStaticMissing: 'gateway_static_missing', // REM-r1 移动站静态产物缺失（404）
  gatewayAttachmentNotFound: 'gateway_attachment_not_found', // 附件 handle 不存在/已清理/hub 不支持读取（404）
  gatewayEnrollmentDisabled: 'gateway_enrollment_disabled', // 动态注册被策略关闭（403）
  remoteCwdInvalid: 'remote_cwd_invalid', // REM-r1 uplink RPC 的 cwd 不存在/逃逸本机工作区（400）
  remoteHubFailed: 'remote_hub_failed', // REM-r1 本机侧 hub RPC 执行失败（经隧道回传网关）
  permissionTimeout: 'permission_timeout', // 网关审批卡超时 auto-deny（GATEWAY_PERMISSION_TIMEOUT_MS）后模型侧工具结果
  askTimeout: 'ask_timeout', // 网关提问卡超时自动关闭（同一时钟）后模型侧工具结果
  mcpFatigueRateLimited: 'mcp_fatigue_rate_limited', // MCP fatigue S0：server 弹窗超限自动 deny（§11.3.9）
  mcpToolUnapproved: 'mcp_tool_unapproved', // MCP fatigue S2 信任门：工具集变更未批准，逐调用 fail-closed

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
  volundSubagentBudgetExceedsDefault: 'VOLUND_SUBAGENT_BUDGET_EXCEEDS_DEFAULT', // §2.7bis.2 预算仲裁（SubagentDispatcher.dispatch 逐维收紧校验实参）
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

  /* ── VolundError 迁移批次（2026-10-06）：infra 域（config / tool-kit / kernel / file-lock / agent-schema） ── */
  agentToolsUnknown: 'agent_tools_unknown', // shared/agent-schema parseAgentDefinition：tools 白名单含父注册表未登记的工具名
  configTomlInvalid: 'config_toml_invalid', // packages/config/src/index.ts TOML 行/键/值/字符串/内联表语法解析失败
  filelockConflict: 'filelock_conflict', // shared/file-lock 跨进程文件锁重试耗尽仍被持有
  kernelPanelMissing: 'kernel_panel_missing', // kernel UiService.panel 取用未注册的面板 id
  toolkitToolConflict: 'toolkit_tool_conflict', // tool-kit ToolRegistry.register 工具名重复注册
  toolkitToolInvalid: 'toolkit_tool_invalid', // tool-kit 工具名与来源前缀（mcp__ / plugin:）不符

  /* ── VolundError 迁移批次：permission 域 ─────────────────────────────── */
  permissionDenied: 'permission_denied', // packages/permission 工具请求被拒绝后无兜底提示
  permissionExecutorAlreadyBound: 'permission_executor_already_bound', // app-runtime/permission bindExecutor 重复绑定
  permissionNetUrlInvalid: 'permission_net_url_invalid', // permission/net-origin InvalidNetUrlError（net 权限 URL 非法）
  permissionParentSnapshotMissing: 'permission_parent_snapshot_missing', // app-runtime/permission PermissionSessionInvariantError
  permissionPathPatternInvalid: 'permission_path_pattern_invalid', // permission/path-pattern PathPatternError（裸名/否定/~user 模式）

  /* ── VolundError 迁移批次：auth / 凭据域 ─────────────────────────────── */
  authCredentialCancelled: 'auth_credential_cancelled', // app-runtime/auth-domain 登录凭据输入被取消
  authPortNotConnected: 'auth_port_not_connected', // cli/ports unavailablePorts 的 auth 存根被调用
  authStoreLocked: 'auth_store_locked', // auth/encrypted-store 凭据库锁定期内访问
  authStoreUnlockFailed: 'auth_store_unlock_failed', // auth/encrypted-store 解密/解锁失败
  authStoreUnavailable: 'auth_store_unavailable', // auth/index login 时无 keychain/encrypted store 可用
  authVerificationFailed: 'auth_verification_failed', // auth/index login verify 回调不通过
  credentialInputCancelled: 'credential_input_cancelled', // cli/runtime promptSecret Ctrl+C 取消
  credentialPassphraseRequired: 'credential_passphrase_required', // cli/runtime 凭据库 passphrase 为空必填
  mcpOAuthFailed: 'mcp_oauth_failed', // auth/mcp-oauth McpOAuthError（MCP OAuth 2.1 客户端流失败）
  providerCredentialUnavailable: 'provider_credential_unavailable', // cli/runtime provider 凭据解析为空
  providerModelUnresolved: 'provider_model_unresolved', // cli/runtime 记忆自动沉淀（ADR-0015）解析不到会话模型

  /* ── VolundError 迁移批次：core / context 域 ─────────────────────────── */
  contextSummaryProviderCompleteUnsupported: 'context_summary_provider_complete_unsupported', // context/index SummaryPolicy provider 无 complete
  coreContextPolicyAlreadyRegistered: 'core_context_policy_already_registered', // core/context-policy-registry 重名注册
  coreContextPolicyNameMismatch: 'core_context_policy_name_mismatch', // core/context-policy-registry 注册名与 policy.name 不符
  coreContextPolicyNoneAvailable: 'core_context_policy_none_available', // core/context-policy-registry 无任何可用 policy
  coreContextPolicyUnknown: 'core_context_policy_unknown', // core/context-policy-registry select 指定名不存在
  coreInternal: 'core_internal', // core/event-bus 附录 D payload 契约内部断言
  corePromptFragmentAlreadyRegistered: 'core_prompt_fragment_already_registered', // core/prompt-composer fragment id 重复注册
  semanticCloudEmbeddingNotAuthorized: 'semantic_cloud_embedding_not_authorized', // context/semantic 云嵌入未授权

  /* ── VolundError 迁移批次：native-bridge 域 ──────────────────────────── */
  nativeBridgeAstQueryNativeRequired: 'native_bridge_ast_query_native_required', // search.ts AST 查询需原生 worker
  nativeBridgeBinaryFileUnsupported: 'native_bridge_binary_file_unsupported', // fs.ts 二进制文件拒绝解码
  nativeBridgeChecksumMismatch: 'native_bridge_checksum_mismatch', // resolver.ts 产物 sha256 不匹配
  nativeBridgePluginBridgeFdUnavailable: 'native_bridge_plugin_bridge_fd_unavailable', // sandbox.ts 插件桥 fd3 不可用
  nativeBridgeReadLimitExceeded: 'native_bridge_read_limit_exceeded', // fs.ts readLarge 超 maxBytes
  nativeBridgeSandboxBinaryMissing: 'native_bridge_sandbox_binary_missing', // sandbox.ts 冻结探测后二进制消失
  nativeBridgeSandboxExecFailed: 'native_bridge_sandbox_exec_failed', // sandbox.ts sandbox 子进程非零退出/启动失败
  nativeBridgeWorkerHandshakeInvalid: 'native_bridge_worker_handshake_invalid', // worker-pool.ts 握手协议号非法
  nativeBridgeWorkerHandshakeTimeout: 'native_bridge_worker_handshake_timeout', // worker-pool.ts worker 握手超时
  nativeBridgeWorkerUnavailable: 'native_bridge_worker_unavailable', // worker-pool.ts worker 不可用（search/fs 共用）

  /* ── VolundError 迁移批次：tools 域（Edit/Write 守卫 + web fetch/search） ── */
  toolEditAmbiguous: 'tool_edit_ambiguous', // tools/index old_string 多处匹配且未 replace_all
  toolEditNoOp: 'tool_edit_no_op', // tools/index Edit/MultiEdit 空操作拒绝
  toolEditNotFound: 'tool_edit_not_found', // tools/index old_string 匹配 0 处
  toolFileChangedAfterWrite: 'tool_file_changed_after_write', // tools/index 写后校验发现并发修改（已回滚）
  toolFileChangedSinceRead: 'tool_file_changed_since_read', // tools/index lost-update 门：读后文件已变
  toolFileNotRead: 'tool_file_not_read', // tools/index Write guard：未读过即覆写
  toolPathEscape: 'tool_path_escape', // tools/index pathInCwd/safeMutationPath 路径逃逸 cwd
  toolSymlinkRejected: 'tool_symlink_rejected', // tools/index 拒绝对符号链接做写变更
  webFetchContentTypeUnsupported: 'web_fetch_content_type_unsupported', // tools/web-fetch 非 text/json/xml
  webFetchEncodingUnsupported: 'web_fetch_encoding_unsupported', // tools/web-fetch content-encoding 非 identity
  webFetchHttpFailed: 'web_fetch_http_failed', // tools/web-fetch 响应状态码非 2xx
  webFetchRateLimited: 'web_fetch_rate_limited', // tools/web-fetch 每 host 每分钟超限
  webFetchRedirectForbidden: 'web_fetch_redirect_forbidden', // tools/web-fetch 重定向跳出许可 origin
  webFetchRedirectInvalid: 'web_fetch_redirect_invalid', // tools/web-fetch 3xx 缺 Location 头
  webFetchRedirectLimitExceeded: 'web_fetch_redirect_limit_exceeded', // tools/web-fetch 重定向次数超上限
  webFetchResponseTooLarge: 'web_fetch_response_too_large', // tools/web-fetch 超字节上限
  webFetchTargetForbidden: 'web_fetch_target_forbidden', // tools/web-fetch SSRF 门：私网/保留地址
  webFetchUrlInvalid: 'web_fetch_url_invalid', // tools/web-fetch 非法绝对 URL / 非 http(s) / 携带凭证
  webSearchProviderFailed: 'web_search_provider_failed', // tools/web-search WebSearchProviderError（provider 调用失败）
  webSearchProviderMissing: 'web_search_provider_missing', // tools/web-search fail-closed：未配置 provider
  webSearchQueryInvalid: 'web_search_query_invalid', // tools/web-search 查询参数校验（空/超长）

  /* ── VolundError 迁移批次：mcp 域 ────────────────────────────────────── */
  mcpFrameTooLarge: 'mcp_frame_too_large', // mcp-client 请求/响应/SSE 事件超尺寸
  mcpHttpFailed: 'mcp_http_failed', // mcp-client HTTP/SSE 请求失败带状态码
  mcpKeyrefUnresolved: 'mcp_keyref_unresolved', // app-runtime/mcp-domain 连接期 keyref 凭据缺失
  mcpLoginTransportUnsupported: 'mcp_login_transport_unsupported', // app-runtime/mcp-domain mcp login 用于 stdio server
  mcpMarketFetchFailed: 'mcp_market_fetch_failed', // app-runtime/mcp-market MCP 市场索引拉取失败
  mcpMarketIndexInvalid: 'mcp_market_index_invalid', // app-runtime/mcp-market 市场索引/registry 文档校验拒绝
  mcpResponseInvalid: 'mcp_response_invalid', // mcp-client MCP 响应体畸形
  mcpServerNameInvalid: 'mcp_server_name_invalid', // mcp-client McpClient 构造：server 名不合法
  mcpServerNotConfigured: 'mcp_server_not_configured', // app-runtime/mcp-domain mcp remove 无配置条目
  mcpServerUnknown: 'mcp_server_unknown', // app-runtime/mcp-domain 按名找不到 MCP server
  mcpSseReconnectExhausted: 'mcp_sse_reconnect_exhausted', // mcp-client SSE 重连次数耗尽
  mcpTestFailed: 'mcp_test_failed', // app-runtime/mcp-domain mcp test 目标非 connected
  mcpTransportStateInvalid: 'mcp_transport_state_invalid', // mcp-client 传输重复 start / 未 start 即 send
  mcpUnavailable: 'mcp_unavailable', // app-runtime/mcp-domain 面板操作时无 MCP manager

  /* ── VolundError 迁移批次：remote-link / 远程域 ──────────────────────── */
  remoteLinkCapabilityUnavailable: 'remote_link_capability_unavailable', // remote-link hub 未实现该能力
  remoteLinkMethodUnknown: 'remote_link_method_unknown', // remote-link 网关发来未知 uplink rpc 方法
  remoteLinkNotStarted: 'remote_link_not_started', // cli/remote 配对时 uplink 未启动
  remoteLinkTokenFailed: 'remote_link_token_failed', // remote-link client_credentials 换 token 失败
  remoteNoActiveSession: 'remote_no_active_session', // cli/remote hub changes* RPC 无活动会话
  remoteSubagentsUnavailable: 'remote_subagents_unavailable', // cli/remote hub 未装配 subagents 面
  subagentNotRunning: 'subagent_not_running', // cli/runtime /subagents 取消目标不在运行

  /* ── VolundError 迁移批次：subagent 域（VOLUND_SUBAGENT_* SCREAMING 族） ── */
  volundSubagentNameMismatch: 'VOLUND_SUBAGENT_NAME_MISMATCH', // subagent/agent-registry frontmatter name 与文件名不一致
  volundSubagentToolsExceedParent: 'VOLUND_SUBAGENT_TOOLS_EXCEED_PARENT', // subagent/agent-registry tools 白名单超出父注册表

  /* ── VolundError 迁移批次：storage 域 ────────────────────────────────── */
  evolutionFileShrank: 'evolution_file_shrank', // storage/evolution-store readRange 恢复期间文件缩短
  storageBackupManifestCorrupt: 'storage_backup_manifest_corrupt', // storage/index readManifest 结构损坏
  storageBackupPathEscape: 'storage_backup_path_escape', // storage/index assertWithin 备份路径逃逸
  storageBackupTargetInvalid: 'storage_backup_target_invalid', // storage/index BackupStore.prepare 目标非常规文件
  storageInternal: 'storage_internal', // storage/index PromptLoader.expand 内部断言
  storageSessionBinaryRejected: 'storage_session_binary_rejected', // storage/index SessionStore.append 拒绝内联二进制
  storageSessionIdInvalid: 'storage_session_id_invalid', // storage/index validateSessionId 非法会话 id
  storageSessionVersionUnsupported: 'storage_session_version_unsupported', // storage/index 会话来自更新版本 volund

  /* ── VolundError 迁移批次：skills / 任务编排域 ───────────────────────── */
  skillMarketFetchFailed: 'skill_market_fetch_failed', // app-runtime/skill-market skill 市场索引拉取失败
  skillMarketIndexInvalid: 'skill_market_index_invalid', // app-runtime/skill-market 市场索引/Claude 清单校验拒绝
  skillNotFound: 'skill_not_found', // app-runtime/skills 托管 scope 找不到 skill / 无 SKILL.md
  skillSourceInvalid: 'skill_source_invalid', // app-runtime/skill-install 安装源解析后无 SKILL.md
  skillsNoActiveSession: 'skills_no_active_session', // app-runtime/skills 面板/斜杠调用时无活动会话

  /* ── VolundError 迁移批次：cli 杂项域 ────────────────────────────────── */
  appIdentityInvalid: 'app_identity_invalid', // cli/shared/app-identity 生产身份版本非法
  askUnavailable: 'ask_unavailable', // app-runtime/ask-interaction 非交互模式提问不可用
  cliInternal: 'cli_internal', // apps/cli 内部断言兜底（dispatcher/schema/端口接线守卫）
  historyImportInvalid: 'history_import_invalid', // cli/history 导入载荷校验失败
  historySessionExists: 'history_session_exists', // cli/history 导入目标会话文件已存在
  sessionTtyRequired: 'session_tty_required', // app-runtime/session-controller 非交互终端且无 prompt
  trustSensitiveScopeRejected: 'trust_sensitive_scope_rejected', // cli/trust 拒绝对敏感目录授予信任

  /* ── VolundError 迁移批次：gateway / 移动站域 ────────────────────────── */
  gatewayBaseInvalid: 'gateway_base_invalid', // mobile/gateway 网关地址须 http(s)
  gatewayDownloadFailed: 'gateway_download_failed', // mobile/gateway 附件下载失败
  gatewayInternal: 'gateway_internal', // gateway-server 装配/注册内部断言
  gatewayNotPaired: 'gateway_not_paired', // mobile/page 无已配对会话
  gatewayPairingFailed: 'gateway_pairing_failed', // mobile/gateway 配对核销失败
  gatewayRequestFailed: 'gateway_request_failed', // mobile/gateway REST 非 2xx
  gatewaySessionExpired: 'gateway_session_expired', // mobile/gateway 401 凭证失效
  gatewayUnreachable: 'gateway_unreachable', // mobile/gateway fetch 断网/CORS 拦截
  gatewayUploadFailed: 'gateway_upload_failed', // mobile/gateway 附件上传失败

  /* ── VolundError 迁移批次：web / market 域 ───────────────────────────── */
  marketConflict: 'market_conflict', // apps/market/lib/http ConflictError（409）
  marketPathEscape: 'market_path_escape', // apps/market/lib/store bundle 路径逃逸
  marketValidationFailed: 'market_validation_failed', // apps/market/lib/validate ValidationError（422）
  telemetryInternal: 'telemetry_internal', // telemetry/index read() 行结构内部断言（原 new Error()）
  webBindHostInvalid: 'web_bind_host_invalid', // web-server createWebServer 非 loopback host
  webPortInvalid: 'web_port_invalid', // web-server createWebServer 端口越界
  webWorkbenchContainerMissing: 'web_workbench_container_missing', // web/CodePage workbench 容器未挂载

  /* ── VolundError 迁移批次：plugins 域 ────────────────────────────────── */
  pluginMarketEntryNotFound: 'plugin_market_entry_not_found', // app-runtime/plugins-domain 目标不在市场索引
  pluginMarketSourceMissing: 'plugin_market_source_missing', // app-runtime/plugins-domain [plugins] market 未配置
  pluginUninstallRejected: 'plugin_uninstall_rejected', // app-runtime/plugins-domain 内置/dev 插件卸载拒绝
  pluginWebSearchAborted: 'plugin_web_search_aborted', // app-runtime/plugins-domain-web-search 搜索被信号中止
  pluginsBuiltinDomainUnknown: 'plugins_builtin_domain_unknown', // app-runtime/plugins-domain 未知工具域 id

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
