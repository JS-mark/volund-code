# 安装

Volund CLI 需要 Node.js 20.19 或更高版本。稳定 npm 版本尚未发布；正式发布获批前，请从源码构建：

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm build
node apps/cli/dist/volund.js --help
```

兼容窗口期内，源码构建仍保留 `dist/volund.js` 这个内部文件名。发布包会将 `volund` 暴露为标准可执行命令，并保留 `volund` 别名。

标准 npm 包名为 `volund-cli`，平台产物使用 `@volund/*` scope；旧 `volund-code` 仅作为兼容 meta 包生成。registry 所有权和首个公开版本仍需通过发布审批。

工作区中的 `0.0.0` 是开发版本，不代表已发布。首次正式发布通过人工审批后，本文档会更新对应的 npm 版本与 Git tag。

JavaScript 包不会内置全部平台的 native 产物。首次使用时，Volund 会从相同版本的 GitHub Release 下载对应 target triple 的 `sandbox`、`search` 和 `fs` 二进制，通过 `checksums.sha256` 校验后按版本缓存；不会从会漂移的 `latest` Release 解析二进制。
