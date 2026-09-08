# 远程网关（volund gateway）

`volund gateway` 把本机 volund 运行时暴露为远程 API：OAuth2 认证、OpenAI 兼容的
SSE 流式补全、WebSocket 交互会话通道。适合把编码 agent 能力挂到 Web 后端、移动端
后端或 CI。

> 部署细节（Docker / Caddy / 域名）见仓库 `deploy/gateway/README.md`。

## 启动

```bash
volund gateway --port 8788          # 或 GATEWAY_PORT
```

首次启动且无客户端配置时，生成 bootstrap 客户端：明文 client_secret 只在启动输出里
打印一次，`~/.volund/gateway/clients.json`（0600）里只存其域分隔 SHA-256 哈希——老的
明文格式文件在下次启动时自动迁移为哈希。签名密钥缺省生成并持久化在
`~/.volund/gateway/token-key`——删掉它会让所有已签发 token 失效。

## 认证

```bash
curl -X POST http://127.0.0.1:8788/oauth/token \
  -H 'content-type: application/x-www-form-urlencoded' \
  -d 'grant_type=client_credentials&client_id=REFID_002Q&client_secret=REFID_004Q'
```

返回的 `access_token` 作为 `Authorization: Bearer <token>` 用于全部 `/v1/*` 端点。

## 会话与并发模型

volund 是**单 runner** 运行时：所有 turn 串行执行（FIFO 队列），忙时请求等待
`GATEWAY_QUEUE_TIMEOUT_MS` 后返回 `409 gateway_session_busy`。WS 通道与
chat/completions 共享同一个活动会话；chat/completions 在无活动会话时创建一次性
会话（turn 结束即 detach，响应头 `x-volund-session-id` 可随时恢复）。

## 端点

| 端点                        | 说明                                                  |
| --------------------------- | ----------------------------------------------------- |
| `POST /oauth/token`         | client_credentials 换 token（form / JSON / Basic 头） |
| `GET /v1/health`            | 健康检查（无需认证）                                  |
| `GET /v1/models`            | OpenAI 形状模型列表（含 `[models.aliases]` 展开）     |
| `GET /v1/sessions`          | 可恢复会话清单                                        |
| `POST /v1/chat/completions` | OpenAI 兼容；`stream: true` 走 SSE                    |
| `GET /v1/ws`                | WebSocket 交互通道（审批/打断/事件流）                |

### chat/completions 映射

- 只支持文本消息（`content` 为 string 或 `[{type:"text"}]`）；多模态 part 返回
  `400 gateway_unsupported_content`。
- 无 `session_id`：整段消息渲染为逐字稿一次性提交（无状态）。
- 有 `session_id`（扩展字段）：续接既有会话，只取最后一条 user 消息。
- `model` 含 `/` 视为 `provider/model` 全限定 id；否则补 `GATEWAY_DEFAULT_PROVIDER`
  前缀；也接受 `[models.aliases]` 里的别名。
- 这是 **agent 调用**：模型在服务端执行工具，返回任务完成后的答复；tool_calls
  不回传。turn 因错误中断时返回 `502 gateway_upstream_failed`（SSE 流内错误帧）。

### WebSocket 帧协议

客户端帧：`ping` / `session.start{cwd?}` / `session.resume{id}` / `session.end` /
`turn.submit{prompt, model?}` / `turn.interrupt` / `permission.decide{requestId, kind}`。
服务端帧：`hello` / `event`（core 事件透传）/ 各命令应答 / `error{code, message}`。
浏览器端不能设 `Authorization` 头，用 `?access_token=` 查询参数代替。

## 权限审批

权限模式由 `GATEWAY_PERMISSION_MODE` 决定（ask/auto/full，默认 auto）。审批卡通过
WS 通道推送（`permission.request` 事件），任一在线 WS 客户端可决策；无人决策超过
`GATEWAY_PERMISSION_TIMEOUT_MS`（默认 120s）自动 deny。chat/completions 没有交互
审批面——在 ask 模式下跑需要提权的工具前先确认有 WS 客户端在线，或用 auto/full。

## 安全面

- token 为 HS256 JWT，强制 iss/exp/签名校验；客户端 secret 常量时间比对；
- `/oauth/token` 每 IP 限流（默认 30/min），`/v1/*` 每客户端限流（默认 600/min）；
- JSON body 4 MiB 上限，WS 消息 1 MiB 上限；客户端帧必须掩码（RFC 6455）；
- CORS 默认关闭，`GATEWAY_CORS_ORIGINS` 显式开白名单；
- WS `session.start` 的 cwd 被关在 `GATEWAY_WORKSPACE` 内（realpath 双重校验）。
