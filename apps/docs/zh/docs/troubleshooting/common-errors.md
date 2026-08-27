# 常见错误

## 状态码 1

命令或输入无效。运行 `volund help` 并修正请求。

## 状态码 2

系统依赖或 provider 失败。运行 `volund doctor` 并检查已脱敏的诊断信息。

## 状态码 3

严格模式检测到沙箱降级。安装匹配的原生包或修复主机机制；不要在验收时绕过。

## 状态码 130

当前 turn 被 Ctrl+C 中断。会话仍然保留，可以继续使用。

## Ollama endpoint 被拒绝

Ollama 默认使用 `http://127.0.0.1:11434`。本机回环 HTTP endpoint 无需确认；
任何非回环 endpoint 都必须进行与该地址绑定的交互式危险确认，非交互运行一律拒绝。
远程明文 HTTP 会让 prompt 和工具数据以未加密形式跨网络传输，风险尤其高。
项目级配置不能覆盖 provider 的 `baseUrl` 或 `endpoint`。

重定向不会被跟随。如需代理，请在用户级配置最终 HTTPS URL，并确认该准确地址。
`volund doctor` 接线应使用 Ollama 版本探测（`GET /api/version`），仅对 Ollama 0.3
及以上版本报告工具支持。
