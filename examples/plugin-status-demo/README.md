# volund-plugin-status-demo

PLUGIN-STATUS-UI-r1 契约的活样例插件：向 `/status` 面板注册两个页签（`Plug` = rows 体例，含会话用量；`Pulse` = heatmap 体例）。

## 装载（dev 通道，不经 Catalog）

约定目录自动发现（REPL 启动与 `volund status` 都会加载）：

```bash
mkdir -p ~/.volund/plugins-dev
cp -r examples/plugin-status-demo ~/.volund/plugins-dev/volund-plugin-status-demo
volund        # REPL 里 /status → Tab/→ 切到 Plug / Pulse 页签
```

仓库内开发时可用符号链接，或用 `VOLUND_DEV_PLUGINS` 追加临时路径：

```bash
ln -s "$PWD/examples/plugin-status-demo" ~/.volund/plugins-dev/volund-plugin-status-demo
# 或
VOLUND_DEV_PLUGINS=examples/plugin-status-demo volund
```

验证（一次性命令）：

```bash
volund status --json | jq '.pluginTabs'
```

数据目录：`~/.volund/plugins-dev-data/volund-plugin-status-demo/`（沙箱内唯一可写根）。

## 说明

- 插件代码只运行在 `volund-sandbox --run-plugin` 沙箱子进程里；与主进程之间是经权限 guard 的 fd3 JSONRPC 桥。
- `render()` 由 K0 在面板打开 / 按 `r` 时回调取值；返回值是纯数据描述符（PLUGIN-STATUS-UI-r1 §S3.2），渲染与 sanitize 都在内核侧。
- manifest `permissions.volund` 必须包含 `ui.status`（页签注册）与 `session.read`（读取会话用量）。
- 已知缺口：沙箱桥暂不提供 `volund.plugin` 元数据（属性访问不触发 RPC），插件身份请硬编码（见 index.mjs 注释）。
