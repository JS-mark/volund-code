# ADR: Distribute native binaries with GitHub Releases

Status: Accepted, 2026-08-03.

## Decision

Volund publishes the 8-target × 3-capability native matrix as immutable GitHub Release assets. Native binaries are not separate npm packages and `native-bridge` has no platform `optionalDependencies`.

Each version tag publishes one asset per capability and target, for example `volund-sandbox-linux-x64-gnu`, plus a `checksums.sha256` manifest. Windows assets use `.exe`. The runtime derives the target from `process.platform`, `process.arch`, and Linux libc; downloads only from the exact application version; verifies SHA-256; stores the executable in a versioned cache; and retains the existing safe fallback when an asset is unavailable. `VOLUND_NATIVE_*_BINARY` remains the explicit development and CI override.

## Consequences

- The repository no longer contains `platforms/*` package manifests.
- Changesets versions JavaScript packages only. Creating a version tag triggers the native matrix and Release upload after its license, doctor, signing-smoke, notarization-gate, and reproducibility dependencies complete.
- First native use may require network access. Offline deployments must pre-seed the cache or provide the existing binary override.
- The 8 native and 8 sandbox-escape validation matrix, Tier disclosures, production signing, notarization, and real-hardware gates are unchanged.

This ADR supersedes the npm platform-package and `optionalDependencies` distribution passages in `01-repo-layout.md`, `05-rust-sidecar.md`, `09-build-ci-dist.md`, `10-milestones.md`, `SANDBOX-COMPAT-r1.md`, and the L1 checklist. Historical review documents remain unchanged as records of earlier decisions.

## Amendment 2026-08-25: CLI 的 npm 渠道改二进制薄壳

本 ADR 的裁决对象是 **native sidecar 单体**（sandbox/search/fs 三个 Rust 二进制）的分发，结论不变：不进 npm、走 GitHub Release 资产 + 运行时校验下载。

2026-08-25 起，**CLI 整体**的 npm 分发改走二进制薄壳；2026-08-27 品牌迁移后 canonical meta 包为 `\@volund/cli`，并生成 legacy `volund-code` 兼容 meta 包。两者都只包含一个 CJS 壳（`bin/volund.cjs`），按宿主 triple 解析 optionalDependencies 里的 `@volund/<triple>` 平台包并 spawn 其中的 bun 单文件二进制；平台包内含完整 standalone 布局（二进制 + native/ + plugins/），是 GitHub Release `volund-standalone-<triple>.tar.gz` 的同内容 npm 形态。与本 ADR 的边界：

- 平台包不是"sidecar 的 npm 分发"——sidecar 在里面是 standalone 布局的组成部分，运行时解析走 execPath 旁惯例，不经过 Release 下载路径；`native-bridge` 依旧无 `optionalDependencies`。
- 平台包不进 pnpm workspace、不经 changesets 版本化（`pnpm-lock.yaml` 不含它们；发布时按 tag 版本打戳）。
- `win32-arm64-msvc` 无 bun 编译目标：npm 上由 `@volund/win32-x64-msvc`（`cpu` 同列 arm64）经 Prism 仿真覆盖；**JS 渠道**的 win-arm64 sidecar 仍按本 ADR 走 Release 资产。
- 发布动作为手动 dispatch（`publish-npm.yml`），带 npm provenance；自动 publish 门禁（签名/公证）不变。
