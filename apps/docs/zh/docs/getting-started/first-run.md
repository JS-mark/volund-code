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

Ctrl+V 粘贴剪贴板附件：剪贴板里的图片会落盘到会话附件库并在输入行插入 `[image_1]`
chip（按粘贴顺序编号），复制的文件（如 Finder 拷贝）插入 `[file: <name>]` chip，纯文本则
原样插入。把文件拖进终端（或粘贴能解析到文件的路径文本）同样会转成附件——工作区内的文件
按路径引用，工作区外的图片会复制进附件库。粘贴不需要授权：chip 只是本地引用，内容只有在你
显式发送消息时才会外发。chip 是不可分割的原子 token——退格整枚删除；发送时 chip 展开为
模型的图片/文件内容。输入历史只保留 chip 文本，不落二进制。

Cmd+V 也能贴图片：剪贴板里没有文本时，终端会发来一个空的粘贴事件，volund 据此读取系统
剪贴板补上图片（与 Claude Code 相同的 onEmptyPaste 语义）。如果你的终端不发这个空事件，
可以用 `/paste`，或把 Cmd+V 重映射为发送 `0x16`（iTerm2：Settings → Keys → Key Bindings →
Cmd+V → Send Hex Codes `0x16`；VS Code：`workbench.action.terminal.sendSequence` 发送
`\u0016`）——volund 的 Ctrl+V 也能插入纯文本，重映射后的 Cmd+V 就是完整的粘贴。

输入区支持 ←/→ 方向键、Home/End、Ctrl+A/Ctrl+E 移动光标，编辑在光标处生效。

如果你的终端把 Ctrl+V 占用成它自己的粘贴，改用 `/paste` 命令——同一条授权粘贴通道，
chip 一样进输入行。

键入 `@` 打开统一选择器：模型别名（⭐ 置顶）和工作区文件（📄）随输入前缀过滤；Enter/Tab
选中（文件转成附件 chip，模型别名当轮覆盖模型），Esc 关闭。
