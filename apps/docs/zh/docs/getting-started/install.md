# 安装

## 独立安装脚本（macOS / Linux）

首个独立发布产物上线后，使用以下命令安装预构建的 `volund` 二进制：

```sh
curl -fsSL https://raw.githubusercontent.com/JS-mark/volund-code/main/scripts/install/install.sh | bash
```

脚本会把当前机器映射到对应的 release target（darwin/linux × arm64/x64 × gnu/musl），从匹配的 GitHub Release 下载 `volund-standalone-<target>.tar.gz`，对照 `release-manifest.json` 做 SHA-256 校验，然后安装到 `~/.volund`（native 侧车与内置插件保持在可执行文件旁，与 standalone 产物解析约定一致），并自动把 `~/.volund/bin` 加入 PATH。

安装指定版本用 `VOLUND_INSTALL_VERSION=v0.1.0` 或第一个参数（`bash -s -- v0.1.0`）。重复执行即原地升级；`rm -rf ~/.volund` 即卸载。Windows 走下方 npm 包或 WSL。

## 从源码构建

Volund CLI 需要 Node.js 20.19 或更高版本。稳定 npm 版本尚未发布；正式发布获批前，请从源码构建：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/volund.js --help
```

兼容窗口期内，源码构建仍保留 `dist/volund.js` 这个内部文件名。发布包会将 `volund` 暴露为标准可执行命令，并保留 `volund` 别名。

标准 npm 包名为 `@volund/cli`，平台产物使用 `@volund/*` scope；旧 `volund-code` 仅作为兼容 meta 包生成。registry 所有权和首个公开版本仍需通过发布审批。

工作区中的 `0.0.0` 是开发版本，不代表已发布。首次正式发布通过人工审批后，本文档会更新对应的 npm 版本与 Git tag。

JavaScript 包不会内置全部平台的 native 产物。首次使用时，Volund 会从相同版本的 GitHub Release 下载对应 target triple 的 `sandbox`、`search` 和 `fs` 二进制，通过 `checksums.sha256` 校验后按版本缓存；不会从会漂移的 `latest` Release 解析二进制。
