# 错误码参考

Volund 的报错通知统一为 **`code: 英文细节`** 格式（web 控制台与移动端一致）：

```text
tool_loop_exhausted: Reached the per-turn limit of 25 consecutive tool-call rounds; …
```

- `code` 是跨模块契约：core 发出 → UI 渲染 → telemetry 分类 → 用户 grep。全部取值集中在
  [`packages/shared/src/error-codes.ts`](https://github.com/JS-mark/volund-code/blob/main/packages/shared/src/error-codes.ts)
  这一张登记表里，新码先登记再使用，`pnpm verify:error-codes` 会在 CI 里强制双向校验
  （裸字符串码未登记、登记了却无人使用都会挂）。
- 细节文案一律英文，便于日志检索与上游 issue 引用；每个码的中文含义以本页为准。
- 本页与登记表同步维护；若发现某个码在报错中出现但本页未收录，以登记表为准并欢迎提 issue。

## 会话回合错误（`error.raised`）

这一组码会直接出现在 web/mobile 的会话通知里，是最常遇到的一组：

| code                                    | 含义                                                                       | 触发场景与处理                                                                                     |
| --------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `tool_loop_exhausted`                   | 单回合工具调用轮数达到上限（默认 25，可配 `runner.maxToolLoopsPerTurn`）   | 大任务（如从零脚手架整个项目）一回合用不完会撞线；已完成的改动会保留，发送「继续」可在新回合接着做 |
| `subagent_budget_exhausted`             | 资源预算耗尽（token 用量/费用/耗时/工具调用次数，细节里会标注是哪一维）    | 调高对应预算后继续                                                                                 |
| `stream_interrupted`                    | 模型流式中断（网络抖动、服务端断连等，细节含底层原因如 `read ECONNRESET`） | 多数可重试；若反复出现检查网络与代理                                                               |
| `stream_resume_unsafe_partial_tool_use` | 流中断时工具调用参数只收到一半，无法安全续传或重放                         | 该回合中止；重新发起请求即可                                                                       |
| `provider_sticky_violation`             | 工具调用在途时不允许切换 provider（粘性保护）                              | 等当前回合结束后再切换模型                                                                         |
| `runner_error`                          | 回合执行中的兜底错误（细节为原始异常消息，如模型不支持图片输入）           | 按细节修正输入或配置                                                                               |
| `internal_error`                        | `--json` 输出模式的兜底错误码                                              | 查看完整日志定位                                                                                   |
| `builtin_hook_error`                    | 内置插件 hook 抛错（组合层映射为 `error.raised`）                          | 按细节检查对应插件                                                                                 |
| `builtin_hook_timeout`                  | 内置插件 hook 超时                                                         | 检查插件逻辑是否阻塞                                                                               |
| `builtin_hook_payload_too_large`        | hook 载荷超过上限被直接否决                                                | 缩减传给 hook 的数据                                                                               |

其余 `error.raised` 相关码（`all_providers_cooling_down` 等）见下文各域速查表。

## Provider / Router / 上下文

模型接入、路由与上下文压缩域：

| code                                            | 说明                                              |
| ----------------------------------------------- | ------------------------------------------------- |
| `all_providers_cooling_down`                    | 所有候选 provider 都在冷却（连续失败熔断中）      |
| `cost_router_explicit_model_unpriced`           | 显式指定的模型缺少定价，成本路由无法核算          |
| `cost_router_no_affordable_route`               | 没有满足成本预算的可用路由                        |
| `cost_router_pricing_missing`                   | 成本路由缺少定价数据                              |
| `cost_router_routes_empty`                      | 成本路由的路由表为空                              |
| `cost_router_usage_estimate_missing`            | 成本路由缺少用量估算                              |
| `fallback_chain_empty`                          | fallback 链为空                                   |
| `fallback_provider_duplicate`                   | fallback 链里出现重复 provider                    |
| `ollama_endpoint_invalid`                       | Ollama endpoint 非法                              |
| `ollama_endpoint_protocol_not_supported`        | Ollama endpoint 协议不支持（仅 HTTP(S)）          |
| `ollama_endpoint_query_or_fragment_forbidden`   | Ollama endpoint 不允许携带 query/fragment         |
| `ollama_endpoint_userinfo_forbidden`            | Ollama endpoint 不允许携带 userinfo               |
| `ollama_redirect_denied`                        | Ollama endpoint 重定向不被跟随（安全策略）        |
| `ollama_redirect_target_changed`                | 重定向目标与已确认地址不一致                      |
| `ollama_remote_endpoint_confirmation_required`  | 非回环 Ollama endpoint 需要交互式危险确认         |
| `ollama_remote_endpoint_non_interactive_denied` | 非交互模式下拒绝非回环 Ollama endpoint            |
| `plugin_provider_cannot_be_default_v1`          | v1 契约下插件 provider 不能设为默认               |
| `provider_capabilities_mismatch`                | provider 能力与请求不匹配（如无视觉能力收到图片） |
| `provider_name_conflict`                        | provider 名字冲突                                 |
| `provider_not_in_fallback_chain`                | 指定 provider 不在 fallback 链中                  |
| `provider_not_registered`                       | provider 未注册                                   |
| `reflection_model_unavailable`                  | 反思模型路由无可用模型（§21）                     |
| `reflection_model_error`                        | 反思模型调用中途失败（§21）                       |
| `reflection_output_invalid`                     | 反思输出契约不过（零注入零存储，§21）             |
| `role_router_candidates_empty`                  | 角色路由的候选为空                                |
| `role_router_config_invalid`                    | 角色路由配置非法                                  |
| `role_router_default_missing`                   | 角色路由缺少默认项                                |
| `role_router_priority_invalid`                  | 角色路由优先级非法                                |
| `role_router_role_unknown`                      | 角色路由遇到未知角色                              |
| `role_router_roles_invalid`                     | 角色路由的 roles 配置非法                         |
| `role_router_route_invalid`                     | 角色路由条目非法                                  |
| `router_budget_exhausted`                       | 路由器预算耗尽                                    |
| `router_route_not_eligible`                     | 路由条目不满足当前条件                            |
| `semantic_embedding_count_mismatch`             | 语义索引向量数量与条目数不一致                    |
| `semantic_embedding_unconfigured`               | 语义索引未配置 embedding                          |
| `semantic_index_invalid`                        | 语义索引非法                                      |
| `sticky_provider_not_in_fallback_chain`         | 粘性 provider 不在 fallback 链中                  |
| `sticky_provider_not_in_role_candidates`        | 粘性 provider 不在角色候选中                      |
| `stream_resume_invalid`                         | 流续传状态非法                                    |
| `stream_resume_unsupported`                     | 当前 provider 不支持流续传                        |
| `stream_truncated`                              | provider 流缓冲超限被截断                         |

## Plugin 与 Hook

| code                                     | 说明                                                               |
| ---------------------------------------- | ------------------------------------------------------------------ |
| `hook_dispatch_timeout`                  | hook 分发超时                                                      |
| `hook_skipped`                           | hook fail-open 被跳过（信号，非故障）                              |
| `hook_priority_out_of_range`             | hook 优先级越界（契约码，现实现用 `plugin_hook_priority_invalid`） |
| `plugin_activation_cancelled`            | 插件激活被取消                                                     |
| `plugin_activation_timeout`              | 插件激活超时                                                       |
| `plugin_already_loaded`                  | 插件已加载，重复装载被拒                                           |
| `plugin_approval_stale`                  | 插件审批凭据已过期                                                 |
| `plugin_approval_required`               | 插件需要审批后才能启用                                             |
| `plugin_auth_template_invalid`           | 插件 auth 模板非法                                                 |
| `plugin_bridge_closed`                   | dev 插件 fd3 桥已关闭                                              |
| `plugin_bridge_frame_too_large`          | 插件桥帧超限                                                       |
| `plugin_bridge_invalid_json`             | 插件桥帧不是合法 JSON                                              |
| `plugin_bridge_no_handler`               | 插件桥无对应处理器                                                 |
| `plugin_bridge_protocol`                 | 插件桥协议违规                                                     |
| `plugin_bridge_remote`                   | 插件桥远端错误                                                     |
| `plugin_bridge_timeout`                  | 插件桥超时                                                         |
| `plugin_status_tab_invalid`              | 插件状态页 tab 定义非法                                            |
| `plugin_status_section_invalid`          | 插件状态页 section 定义非法                                        |
| `plugin_callback_cancelled`              | 插件回调被取消                                                     |
| `plugin_callback_failed`                 | 插件回调执行失败                                                   |
| `plugin_callback_timeout`                | 插件回调超时                                                       |
| `plugin_command_invalid`                 | 插件命令注册 spec 校验失败                                         |
| `plugin_command_target_required`         | 插件命令缺少 target                                                |
| `plugin_command_unknown`                 | 未知插件命令                                                       |
| `plugin_config_undeclared`               | 使用了插件 manifest 未声明的配置键                                 |
| `plugin_deactivated`                     | 插件已停用                                                         |
| `plugin_engine_incompatible`             | 插件引擎版本不兼容                                                 |
| `plugin_exec_denied`                     | 插件执行子进程被权限拒绝                                           |
| `plugin_fs_denied`                       | 插件文件访问被权限拒绝                                             |
| `plugin_heartbeat_timeout`               | 插件宿主心跳超时                                                   |
| `plugin_hook_kv_quota_exceeded`          | hook KV 存储超出配额                                               |
| `plugin_hook_priority_invalid`           | hook 优先级非法                                                    |
| `plugin_hook_timeout`                    | hook 执行超时                                                      |
| `plugin_host_exited`                     | 插件宿主进程退出                                                   |
| `plugin_integrity_failed`                | 插件完整性校验失败                                                 |
| `plugin_lifecycle_authority_mismatch`    | 插件生命周期操作者无权限                                           |
| `plugin_integration_unavailable`         | 插件集成能力不可用                                                 |
| `plugin_internal_error`                  | 插件 RPC 兜底错误                                                  |
| `plugin_legacy_activation_unavailable`   | 旧版激活通道不可用                                                 |
| `plugin_manifest_invalid`                | 插件 manifest 非法                                                 |
| `plugin_memory_hook_dispatch_required`   | memory hook 缺少必需的 dispatch 声明                               |
| `plugin_memory_hook_scope_required`      | memory hook 缺少 scope                                             |
| `plugin_memory_scope_denied`             | memory scope 被拒                                                  |
| `plugin_memory_unavailable`              | memory 服务不可用                                                  |
| `plugin_memory_write_denied`             | memory 写入被拒                                                    |
| `plugin_net_denied`                      | 插件网络访问被权限拒绝                                             |
| `plugin_not_enabled` / `plugin_disabled` | 插件未启用/已禁用                                                  |
| `plugin_not_installed`                   | 插件未安装                                                         |
| `plugin_path_escape`                     | 插件路径逃逸（越出允许目录）                                       |
| `plugin_permission_denied`               | 插件权限被拒                                                       |
| `plugin_provider_invalid`                | 插件 provider 定义非法                                             |
| `plugin_provider_net_required`           | 插件 provider 声明了网络需求但未获授权                             |
| `plugin_provider_permission_required`    | 插件 provider 需要额外权限                                         |
| `plugin_rpc_frame_too_large`             | 插件 RPC 帧超限                                                    |
| `plugin_rpc_invalid_json`                | 插件 RPC 帧不是合法 JSON                                           |
| `plugin_rpc_method_denied`               | 插件 RPC 方法被拒（不在白名单）                                    |
| `plugin_rpc_params_invalid`              | 插件 RPC 参数非法                                                  |
| `plugin_rpc_quota_exceeded`              | 插件 RPC 超出配额                                                  |
| `plugin_rpc_transport_only`              | 该 RPC 方法仅限传输层使用                                          |
| `plugin_rpc_version`                     | 插件 RPC 版本不匹配                                                |
| `plugin_state_invalid`                   | 插件持久化状态非法                                                 |
| `plugin_symlink_rejected`                | 插件目录含被拒符号链接                                             |
| `plugin_ui_invalid`                      | 插件 UI 定义非法                                                   |
| `plugin_ui_permission_required`          | 插件 UI 能力需要授权                                               |

## 市场与插件管理

`volund plugins` / 市场面板域：

| code                                 | 说明                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| `mcp_add_invalid`                    | MCP server 添加参数非法                                |
| `mcp_add_failed`                     | MCP server 添加失败                                    |
| `mcp_action_failed`                  | MCP server 操作失败                                    |
| `skill_command_failed`               | skill 命令执行失败                                     |
| `plugins_action_failed`              | 插件管理操作失败                                       |
| `plugin_tool_invalid`                | 插件工具定义非法                                       |
| `plugin_web_search_invalid`          | WebSearch provider 注册不合法（缺 id 或 search 回调）  |
| `plugin_hook_invalid`                | 插件 hook 定义非法                                     |
| `plugin_prompt_invalid`              | 插件 prompt 定义非法                                   |
| `plugin_market_fetch_failed`         | 市场源拉取失败（网络/被墙/源不可达）                   |
| `plugin_market_index_invalid`        | 市场 index 非法                                        |
| `plugin_market_metadata_invalid`     | 市场条目元数据非法                                     |
| `plugin_market_source_invalid`       | 市场源配置非法                                         |
| `plugin_market_source_pollution`     | 市场源被污染（响应与登记指纹不符）                     |
| `plugin_registry_digest_mismatch`    | 注册表摘要不匹配                                       |
| `plugin_registry_metadata_invalid`   | 注册表元数据非法                                       |
| `plugin_registry_revoked`            | 条目已被吊销                                           |
| `plugin_registry_signature_invalid`  | 注册表签名校验失败                                     |
| `plugin_registry_signature_required` | 注册表缺少必需签名                                     |
| `plugin_registry_source_invalid`     | 注册表源非法                                           |
| `plugin_registry_source_pollution`   | 注册表源被污染                                         |
| `plugin_signing_approval_required`   | 插件签名操作需要审批                                   |
| `plugin_signing_credentials_missing` | 签名凭据缺失                                           |
| `plugin_archive_invalid`             | `.volund` 归档非法（缺 EOCD / 目录损坏 / 缺 manifest） |
| `plugin_archive_unsafe_entry`        | 归档条目名逃逸目标目录（zip-slip）                     |
| `plugin_archive_unsupported_method`  | 归档使用了 store 以外的压缩方法                        |
| `plugin_target_exists`               | 脚手架目标目录非空（`plugins crate`）                  |

## 定时任务

`volund tasks` / `volund daemon` 域（见[定时任务指南](../guides/scheduled-tasks.md)）：

| code                      | 说明                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `tasks_disabled`          | 调度器未启用（`[tasks].enabled` 不是 `true`）                                    |
| `task_daemon_running`     | 另一个 daemon（pid 仍存活）已持有调度锁                                          |
| `task_definition_invalid` | 任务定义未通过校验（`TaskStore.upsertTask` 实参）                                |
| `task_io`                 | 任务存储锁超时 / 存储事务 IO 错误                                                |
| `task_run_failed`         | 任务运行失败（spawn 失败 / 超时击杀 / 非零退出 / daemon 中断）                   |
| `task_store_corrupt`      | 任务存储快照与恢复备份均不可读                                                   |
| `task_config_drift`       | 拒绝运行：用户级 config.toml 内容 hash（不含 [tasks] 段）与冻结值不一致（F1-03） |
| `task_trust_missing`      | 拒绝运行：任务冻结的工作目录已不被信任（F1-03）                                  |

## Evolution 本地存储

自进化记录/journal 域（packages/storage）：

| code                                    | 说明                               |
| --------------------------------------- | ---------------------------------- |
| `evolution_namespace_apply_unsupported` | 该存储后端不支持按 namespace 应用  |
| `evolution_record_continuity`           | 记录链不连续                       |
| `evolution_record_cross_constraint`     | 记录违反跨条目约束                 |
| `evolution_record_future_schema`        | 记录 schema 版本超前（新版本写入） |
| `evolution_record_invalid`              | 记录非法                           |
| `evolution_record_line_too_large`       | 单条记录超长                       |
| `evolution_record_sequence_regression`  | 记录序号回退                       |
| `evolution_record_time_regression`      | 记录时间戳回退                     |
| `evolution_journal_recovery_aborted`    | journal 恢复被中止                 |
| `evolution_journal_recovery_completed`  | journal 恢复完成（信号）           |
| `evolution_journal_recovery_required`   | 检测到 journal 需要恢复            |
| `evolution_lock_stolen`                 | 存储锁被抢占                       |

## Memory

| code                          | 说明                        |
| ----------------------------- | --------------------------- |
| `memory_conflict`             | memory 写入冲突             |
| `memory_corrupt`              | memory 数据损坏             |
| `memory_hook_failed`          | memory hook 执行失败        |
| `memory_hook_reentrant`       | memory hook 重入被拒        |
| `memory_hook_veto`            | memory hook 否决了本次操作  |
| `memory_index_busy`           | memory 索引忙               |
| `memory_index_corrupt`        | memory 索引快照损坏         |
| `memory_index_unavailable`    | memory 索引不可用           |
| `memory_io`                   | memory 读写 IO 错误         |
| `memory_not_found`            | 目标 memory 不存在          |
| `memory_scope_denied`         | memory scope 越权访问       |
| `memory_transfer_unavailable` | memory transfer 能力未装配  |
| `memory_unknown`              | memory 域未分类错误（兜底） |
| `memory_validation`           | memory 数据校验失败         |

## CLI / 配置 / 会话

`volund` CLI 与 `--json` 错误协议（`reason.code`）域：

| code                               | 说明                                           |
| ---------------------------------- | ---------------------------------------------- |
| `config_invalid`                   | 配置文件非法                                   |
| `config_project_forbidden`         | 项目级配置写入了不允许的键                     |
| `config_unavailable`               | 配置不可读                                     |
| `config_unknown_key`               | 未知配置键                                     |
| `current_model_source_unavailable` | 当前模型来源信息不可用                         |
| `directory_untrusted`              | 目录未加入信任列表（信任门拦截）               |
| `filesystem_isolation_unavailable` | 文件系统隔离机制不可用                         |
| `invalid_workspace`                | 非法工作区                                     |
| `mcp_list_failed`                  | MCP server 列表获取失败                        |
| `mcp_port_unavailable`             | MCP 端口不可用                                 |
| `plugin_http_not_connected`        | 插件 HTTP 通道未连接                           |
| `plugin_ui_not_connected`          | 插件 UI 通道未连接                             |
| `prompt_required`                  | 缺少 prompt 输入                               |
| `proxy_alpn_not_h2`                | 代理隧道 ALPN 未协商出 h2                      |
| `proxy_tunnel_aborted`             | 代理 CONNECT 隧道被中止                        |
| `proxy_tunnel_closed`              | 代理 CONNECT 隧道在建立前关闭                  |
| `proxy_tunnel_failed`              | 代理隧道建立失败                               |
| `proxy_tunnel_rejected`            | 代理拒绝了 CONNECT 请求                        |
| `sandbox_network_blocked`          | 沙箱内网络访问被拦截                           |
| `sandbox_unavailable`              | 沙箱机制不可用                                 |
| `session_id_invalid`               | 会话 id 非法                                   |
| `session_id_required`              | 缺少会话 id                                    |
| `session_not_found`                | 会话不存在                                     |
| `session_resume_failed`            | 会话恢复失败                                   |
| `session_turn_in_progress`         | 会话已有回合在执行（回合互斥；web 层映射 409） |

## Web 控制台

嵌入式 web 服务（packages/web-server）域：

| code                          | 说明                                         |
| ----------------------------- | -------------------------------------------- |
| `web_origin_rejected`         | Host/Origin 不属于本回环服务（CSRF 防线）    |
| `web_session_invalid`         | 浏览器 session 缺失/过期/nonce 已用          |
| `web_csrf_invalid`            | 写请求缺 CSRF 头或不匹配                     |
| `web_schema_invalid`          | 未知端点或请求体非法                         |
| `web_capability_unavailable`  | 能力未接线（诚实降级）                       |
| `web_attachment_rejected`     | 附件类型/大小/魔数校验失败或无活动会话       |
| `web_attachment_not_found`    | 附件 handle 不存在或已清理                   |
| `web_state_conflict`          | 嵌入式模式下会话所有权在 TUI，web 侧操作被拒 |
| `web_session_group_not_found` | 会话分组 id 不存在                           |
| `trust_store_unavailable`     | 信任存储不可用                               |
| `unsupported_flag`            | 不支持的启动旗标                             |

## 远程网关

packages/gateway-server 域（HTTP 状态码映射见括号）：

| code                           | 说明                                                            |
| ------------------------------ | --------------------------------------------------------------- |
| `gateway_auth_invalid`         | Bearer token 缺失/过期/签名不符（401）                          |
| `gateway_client_rejected`      | OAuth client 凭证错误（401）                                    |
| `gateway_grant_unsupported`    | grant_type 不支持（400）                                        |
| `gateway_rate_limited`         | 触发每客户端/每 IP 限流（429）                                  |
| `gateway_schema_invalid`       | 请求体/帧形状非法或未知端点（400/404）                          |
| `gateway_session_busy`         | 会话 runner 被占用或排队超时（409）                             |
| `gateway_session_not_found`    | 会话不存在或不可恢复（404）                                     |
| `gateway_unsupported_content`  | chat 携带了不支持的多模态 part（400）                           |
| `gateway_upstream_failed`      | runner/装配侧失败（502）                                        |
| `gateway_ws_protocol_error`    | WS 帧非 JSON / 缺 type / 未知类型                               |
| `gateway_uplink_offline`       | 本机未拨出注册或隧道断开（503）                                 |
| `gateway_pairing_invalid`      | 配对码不存在/过期/已核销（400）                                 |
| `gateway_static_missing`       | 移动站静态产物缺失（404）                                       |
| `gateway_attachment_not_found` | 附件 handle 不存在/已清理（404）                                |
| `gateway_enrollment_disabled`  | 动态注册被策略关闭（403）                                       |
| `remote_cwd_invalid`           | uplink RPC 的 cwd 不存在或逃逸本机工作区（400）                 |
| `remote_hub_failed`            | 本机侧 hub RPC 执行失败（经隧道回传）                           |
| `permission_timeout`           | 审批卡超时被自动拒绝后模型侧看到的工具结果                      |
| `ask_timeout`                  | 提问卡超时被自动关闭后模型侧看到的工具结果                      |
| `mcp_fatigue_rate_limited`     | MCP server 审批弹窗超分钟限速被自动拒绝后的模型侧结果           |
| `mcp_tool_unapproved`          | MCP server 工具集变更未重新批准（信任门）时模型侧看到的工具结果 |

::: tip 审批卡与提问卡超时
权限审批卡默认 **120 秒无人决策自动拒绝**，提问卡（ask）共用同一时钟、无人作答自动
关闭——这是核心审批队列的内建兜底（TUI / Web / 移动端 / line 模式问询一致），经网关
的场景另受 `GATEWAY_PERMISSION_TIMEOUT_MS` 控制，二者都可用用户级 config
`[permissions] request_timeout_ms` 调整（毫秒，`0` 关闭兜底）。此时模型看到的工具
结果是 `permission_timeout: <工具名> approval timed out …`（提问为 `ask_timeout: …`）
——它表示「超时无人处理」，不是权限配置错误。远程任务频繁卡住时优先检查卡片是否有人处理。
:::

## UI（主题 / 斜杠命令）

| code                             | 说明                     |
| -------------------------------- | ------------------------ |
| `slash_command_builtin_reserved` | 斜杠命令名与内置命令冲突 |
| `slash_command_conflict`         | 斜杠命令名重复注册       |
| `slash_command_invalid_name`     | 斜杠命令名非法           |
| `theme_invalid`                  | 主题定义非法             |
| `theme_invalid_json`             | 主题文件不是合法 JSON    |
| `theme_version_unsupported`      | 主题版本不受支持         |

## 传输协议（`VOLUND_*` 常量码）

RPC/传输层的 gRPC 风格常量码：

| code                                     | 说明                         |
| ---------------------------------------- | ---------------------------- |
| `VOLUND_INVALID_CWD`                     | cwd 非法                     |
| `VOLUND_INVALID_REQUEST`                 | 请求非法                     |
| `VOLUND_METHOD_NOT_FOUND`                | RPC 方法不存在               |
| `VOLUND_PROTOCOL_INVALID`                | 协议违规                     |
| `VOLUND_RESOURCE_EXHAUSTED`              | 资源耗尽                     |
| `VOLUND_SUBAGENT_BUDGET_EXCEEDS_DEFAULT` | subagent 预算超过默认上限    |
| `VOLUND_SUBAGENT_CONCURRENCY_EXCEEDED`   | subagent 并发超限            |
| `VOLUND_SUBAGENT_DEPTH_EXCEEDED`         | subagent 嵌套深度超限        |
| `VOLUND_SUBAGENT_FAILED`                 | subagent 执行失败            |
| `VOLUND_SUBAGENT_UNKNOWN_AGENT`          | 引用了未定义的 subagent 类型 |
| `VOLUND_UNSAFE_CWD`                      | cwd 不安全（信任门）         |
| `VOLUND_UNSUPPORTED_VERSION`             | 协议版本不受支持             |

## 动态归一码（`VOLUND_<CATEGORY>`）

provider/工具/MCP/插件抛出的未知错误经 `normalizeError` 归一后，code 形如
`VOLUND_<分类大写>`，message 保留上游原文：

| code                        | 分类                          |
| --------------------------- | ----------------------------- |
| `VOLUND_NETWORK`            | 网络错误（可重试）            |
| `VOLUND_AUTH`               | 认证失败（检查 API key）      |
| `VOLUND_RATE_LIMIT`         | 上游限流（带 retryAfterMs）   |
| `VOLUND_QUOTA`              | 配额耗尽                      |
| `VOLUND_INVALID_REQUEST`    | 请求参数被上游拒绝            |
| `VOLUND_CONTENT_FILTER`     | 内容被上游安全策略拦截        |
| `VOLUND_MODEL_NOT_FOUND`    | 模型名不存在或无权限          |
| `VOLUND_SERVER`             | 上游服务端错误（5xx，可重试） |
| `VOLUND_CONTEXT_LENGTH`     | 上下文超长（需压缩会话）      |
| `VOLUND_STREAM_TRUNCATED`   | 流被截断                      |
| `VOLUND_PROTOCOL`           | 上游协议违规                  |
| `VOLUND_PERMISSION`         | 权限不足                      |
| `VOLUND_SANDBOX`            | 沙箱相关错误                  |
| `VOLUND_TIMEOUT`            | 超时                          |
| `VOLUND_CANCELLED`          | 操作被取消                    |
| `VOLUND_RESOURCE_EXHAUSTED` | 资源耗尽                      |
| `VOLUND_UNKNOWN`            | 未分类（兜底）                |

## 原生 worker（预留）

为原生 worker 池登记但尚未 emit——worker 池目前以 restart 计数降级，不抛出这些码：

| code                    | 说明                                        |
| ----------------------- | ------------------------------------------- |
| `search_worker_crashed` | 搜索 worker 池丢失一个 worker（B.2 §5.6.1） |
| `fs_worker_crashed`     | fs worker 池丢失一个 worker（B.2 §5.8）     |

## 测试基建

随 `@volund/testkit` 发布，只应出现在测试环境：

| code                                              | 说明                           |
| ------------------------------------------------- | ------------------------------ |
| `mock_provider_disposed`                          | mock provider 已销毁后仍被使用 |
| `mock_provider_script_exhausted`                  | mock provider 的脚本已耗尽     |
| `testkit_injection_requires_non_negative_integer` | 注入参数必须为非负整数         |
| `testkit_path_escape`                             | testkit 路径逃逸               |
| `testkit_truncate_utf8_requires_surrogate_pair`   | UTF-8 截断需要代理对边界       |
| `toml_unsupported_number`                         | TOML 不支持该数字写法          |
| `toml_unsupported_type`                           | TOML 不支持该类型              |
