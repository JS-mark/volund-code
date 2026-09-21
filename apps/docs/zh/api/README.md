# API 参考（导读）

> API 参考由 TypeDoc 从 TypeScript 导出生成，**内容为英文**；本页是中文导读，各模块详情点击后进入对应英文参考页。

Volund CLI 的公开 API 按包划分为以下模块（`@volund/<模块名>`）：

| 模块 | 职责 |
| --- | --- |
| [auth](/api/auth/src/README) | 凭据存储、OAuth（含 McpOAuthError） |
| [config](/api/config/src/README) | config.toml 加载与校验 |
| [context](/api/context/src/README) | 会话上下文 |
| [core](/api/core/src/README) | 内核核心 |
| [native-bridge](/api/native-bridge/src/README) | 原生沙箱 / 搜索 / fs 二进制桥 |
| [permission](/api/permission/src/README) | 权限判定与模式 |
| [plugin-runtime](/api/plugin-runtime/src/README) | 插件宿主、manifest 校验、沙箱 profile |
| [plugin-sdk](/api/plugin-sdk/src/README) | 插件 SDK 类型（manifest、inventory） |
| [provider-anthropic](/api/provider-anthropic/src/README) | Anthropic 提供方 |
| [provider-kit](/api/provider-kit/src/README) | 提供方公共套件 |
| [provider-openai](/api/provider-openai/src/README) | OpenAI 兼容提供方 |
| [router](/api/router/src/README) | 模型路由 |
| [shared](/api/shared/src/README) | 错误码、事件、共享类型 |
| [skills-runtime](/api/skills-runtime/src/README) | Skill 发现与安装 |
| [storage](/api/storage/src/README) | 存储层 |
| [telemetry](/api/telemetry/src/README) | 遥测采样 |
| [tool-kit](/api/tool-kit/src/README) | 工具公共套件 |
| [tools](/api/tools/src/README) | 内置工具 |
| [ui](/api/ui/src/README) | TUI 组件 |

面向使用方的命令与示例请直接看[使用指南](/zh/docs/guides/managing-skills)与
[CLI 参考](/zh/docs/reference/cli)——API 层主要面向参与内核与插件开发的贡献者。
