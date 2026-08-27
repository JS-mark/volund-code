---
title: 主题与插件 UI
---

# 主题与插件 UI

Volund 主题文件使用 `schemaVersion: 1`，并且必须且只能包含八个六位十六进制颜色 token：`background`、`foreground`、`muted`、`accent`、`success`、`warning`、`error`、`border`。内置 `dark` 与 `light` 主题始终可用；版本不支持、token 缺失/多余或值非法时会确定性回退到所选内置主题，并保留诊断信息。

插件 UI 只能通过 manifest 声明。v1 仅允许 `status-bar` 上的纯文本 item，并要求 `permissions.volund` 包含 `ui.contribute`。这里的 `permissions.volund` 是冻结的 v1 manifest 兼容字段；产品与 CLI 已更名为 Volund，但该字段要等版本化插件 ABI 迁移后才能调整。运行时按插件隔离注册，在 disable、uninstall、激活失败或退出时清理。未知 surface、重复 ID、控制字符、过长文本、未知字段（包括组件或模块引用）都会拒绝 manifest。插件不能注入组件，也不能访问其他插件的数据。

在 `--no-tui`、JSON 等 headless 模式下，UI registry 是确定性的 no-op：贡献不会写 stdout，也不会改变退出码。
