# Skill 与图像附件

Apollo 按分层作用域发现 skill（项目级 `.apollo/skills/` 与 `.agents/skills/`，用户级 `~/.apollo/skills/` 与 `~/.agents/skills/`)，每个可被用户调用的 skill 都会注册为同名 slash 命令。启动时只读 YAML frontmatter 并向 system prompt 注入一份紧凑索引。一次性调用 `/skill-name [任务]` 会把 skill 正文与任务文本作为当轮用户消息提交（不持久改 prompt);`/skill activate <name>`（或 `/skills` 面板 `a` 键）把 skill 常驻进会话 prompt 直到关闭。Skill 只注入提示内容：不执行代码，也不授予权限。启停状态持久写在 `~/.apollo/config.toml` 的 `[skills] disabled` 名单。`/skills` 面板列出全部已发现 skill 的作用域与状态（active / available / disabled / shadowed / broken / incompatible),shadowed 与 broken 附带原因。

同名 skill 在高优先级层存在时，低优先级层的同名条目标记为 shadowed（面板里可见），不报错。

图像附件以内容寻址的文件形式存在会话 `attachments` 目录下；会话 JSONL 只保存不透明句柄、MIME 与消息元数据，二进制字节从不进事件日志。PNG / JPEG / GIF / WebP 经签名校验与尺寸检查后接受。Provider 适配器在发请求前再各自校验一次能力、MIME 与尺寸上限。

所选 provider 不支持视觉时，Apollo 会把该请求的图像部分替换为可见的文本占位符；持久化的会话消息保留原句柄，因此恢复会话或切换到支持视觉的 provider 都不会丢附件。

真实 provider 视觉调用需要用户凭据，且必须显式人工验证。fixture 测试覆盖 Anthropic 与 OpenAI 的请求映射，不声称在线 provider 证据。
