# 首次运行

在代码仓库中执行 `volund`。写入任何配置前，引导流程会说明遥测默认仅保存在本地，并展示当前检测到的 Sandbox Tier。

1. 选择 Anthropic 作为 provider。
2. 只在 Volund 遮罩显示的凭据输入框中输入 API key。不要把密钥粘贴到聊天、Shell 历史、日志、Issue 或 commit 中。
3. Volund 会先验证凭据，再写入系统钥匙串或加密的降级存储。
4. 仔细检查每一次写文件、执行命令和网络访问请求；不理解的请求应当拒绝。

真实任务前先执行 `volund doctor --strict`。沙箱降级时命令会以状态码 3 退出。`--dangerously-no-sandbox` 需要显式风险确认，不得用于发布验收。

# 首次交互界面

目录信任检查完成后，交互式 `volund chat` 会在首次输入前显示终端状态页，列出实际生效的模型、
认证可用性、规范化工作目录、信任范围、sandbox 层级、权限模式、会话与上下文预算。无法读取的
状态显示为 `unknown` 或 `not configured`，不会推断认证或安全状态正常。

命令输入区使用 Enter 发送、Shift+Enter 换行，并忽略空输入。`--json` 与 `--no-tui` 始终保持
机器输出或逐行输出，不渲染欢迎页。
