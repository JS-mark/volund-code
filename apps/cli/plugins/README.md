# 内置插件（builtin plugins）

随 CLI 产物分发的插件，与 dev 插件（`~/.volund/plugins-dev/`）共用同一条装载链路：
manifest 校验 → bundle 完整性检查 → `volund-sandbox --run-plugin` 沙箱子进程 → fd3 JSONRPC 桥。
差异仅在目录来源——内置插件只信产物本身。

## 目录约定

- 源码：`apps/cli/plugins/<name>/`（`manifest.json` + 单文件零依赖 ESM `index.mjs`）
- npm 产物：`pnpm build` 时把 `index.mjs` 经嵌套 rolldown **压缩混淆**（compress + 顶层
  mangle，仅保留沙箱装载依赖的 `activate` 导出名）后落到 `dist/plugins/<name>/`，
  `manifest.json` 原样拷贝（见 `rolldown.config.mjs`）——源码不随产物分发
- standalone 产物：`build:standalone` 直接复用 `dist/plugins/`（同一份压缩混淆字节，
  见 `scripts/release/build-standalone.mjs`）
- 运行时解析（`builtinPluginRoot()`，runtime.ts）：`$VOLUND_STANDALONE_ASSET_DIR/plugins`
  → `dist/plugins`（bundled）→ `apps/cli/plugins`（源码/vitest），取第一个存在的

## 版本对齐

内置插件与 CLI 同生命周期，`engines.volund` 用 `^<当前 minor>`；CLI 版本号 bump 时
同步 bump 各内置插件 manifest 的 `version` 与 `engines.volund`。

## 现有内置插件

| 插件                    | 贡献                                                                                                                   | 权限                                                               |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `volund-plugin-env`     | `/env` 斜杠命令（查看 `[env]` 配置段的生效状态与沙箱透传情况）                                                         | `commands.register`, `env.read`, `log.write`                       |
| `volund-plugin-manager` | `/plugins` 斜杠命令（三页签浏览 builtin/dev/market 装载清单 + `install`/`uninstall`/`help` 子命令，PLUGIN-MANAGER-r1） | `commands.register`, `plugins.read`, `plugins.manage`, `log.write` |
