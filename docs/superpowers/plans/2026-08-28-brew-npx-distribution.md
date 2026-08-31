# Brew + npx 直接分发实施计划（2026-08-28）

> **状态**：DESIGN READY / IMPLEMENTATION PARTIAL / NOT PUBLISHED
>
> **目标**：让用户可以通过 `npx --yes volund-cli@latest` 零安装运行，或通过 `brew install JS-mark/tap/volund` 持久安装；两个渠道必须消费同一 tag、同一版本、同一组已校验 standalone 产物。
>
> **边界**：本文只授权完善设计和后续仓库内实现，不授权注册 npm scope、创建 Homebrew tap、发布 npm 包、创建 tag/GitHub Release、签名、公证或上传外部渠道。
>
> **品牌真值**：display=`Volund CLI`，command=`volund`，npm meta=`volund-cli`，platform scope=`@volund/*`，repository=`volund-code`，Homebrew formula token=`volund`。

## 1. 结论

项目不是从零开始：standalone 构建、npm meta/platform package、GitHub Release 资产和手动 npm publish workflow 已有局部实现。但当前只能称为 **implemented-unverified**，不能称为已经支持 `npx` 或 Homebrew 直接安装。

目标用户路径冻结为：

```sh
# 零安装；需要 Node.js/npm
npx --yes volund-cli@latest --help

# 可复现运行；文档、CI、issue 复现优先使用固定版本
npx --yes volund-cli@<version> --version

# npm 持久安装
npm install --global volund-cli@latest
volund --version

# Homebrew 一条命令直接安装 tap 中的 formula；不需要 Node.js
brew install JS-mark/tap/volund
volund --version
```

第一阶段不以 `brew install volund` 为外部承诺。只有用户已经显式 tap，或未来进入 `homebrew/core` 后，短命令才成立。Homebrew 官方推荐的第三方 tap 单命令形态是 `brew install user/repository/formula`。

## 2. 当前状态与证据

| 能力 | 当前证据 | 判定 |
|---|---|---|
| CLI standalone | `scripts/release/build-standalone.mjs`、`scripts/release/build-all-standalone.mjs` 可组装 7 个 Bun executable target | local code exists |
| npm 包图 | `scripts/release/pack-standalone-npm.mjs` 生成 `volund-cli`、legacy `volund-code` 和 `@volund/<triple>` | local code exists |
| npx 入口 | meta package 有唯一 `bin: { volund: bin/volund.cjs }`；npm/npx 会选择唯一 bin | structurally ready |
| 壳转发 | 当前测试覆盖 platform package 解析、argv 与 exit code 转发 | unit/integration partial |
| npm 发布 | `.github/workflows/publish-npm.yml` 可手动 dispatch，带 provenance | configured, not closed-loop |
| GitHub Release | `.github/workflows/native.yml` 构建 standalone archives 并上传 | configured, external gates blocked |
| Homebrew | 旧 HEAD 曾有 blocked dry-run Formula 生成器；当前工作树正在删除该 placeholder 体系 | no production path |
| npm registry | 2026-08-28 只读查询：`volund-cli`、`volund-code`、`@volund/darwin-arm64` 均返回 404 | not published / ownership unverified |
| Homebrew tap | 2026-08-28 只读查询：`JS-mark/homebrew-tap` 返回 404 | tap does not exist |
| 发布资格 | `docs/releases/L2-RELEASE-CHECKLIST.md` 仍有 real hardware、production signing、Apple notarization 和 publication human gates | BLOCKED |

当前针对 npm staging 的 3 个测试通过；这只证明目录级打包和薄壳转发，不证明 registry 安装、`npx` 下载执行、Homebrew 安装或真实发布成功。

## 3. 必须先修的设计/实现问题

### P0-1 · npm 发布 glob 会重复发布 meta 包

当前：

```sh
for dir in dist/npm/volund-*/; do
  npm publish "$dir"
done
npm publish dist/npm/volund-cli
npm publish dist/npm/volund-code
```

`volund-*/` 同时匹配 `volund-cli/`、`volund-code/` 和平台目录。meta 包会在循环中被提前发布，后续显式发布将重复并失败，也破坏“平台包先于 meta 包”的原子顺序。

修正：packer 输出机器可读 `publish-plan.json`，workflow 严格按其中的 `platformPackages[] → canonicalMeta → legacyMeta` 顺序发布；禁止再用目录 glob 推断包类型。

### P0-2 · 两份同名 checksums 可能在 Release 中互相覆盖

raw sidecar 和 standalone archives 当前都可能生成 `checksums.sha256`，上传又使用 `--clobber`。同一 Release 不能用同名资产表达两个不同校验域。

修正：冻结为：

- `sidecars-checksums.sha256`
- `standalone-checksums.sha256`
- `release-manifest.json`

已经发布的 tag 禁止覆盖资产。重试时若远端存在同名资产，必须比较 digest；相同则幂等成功，不同则失败并要求新版本。

### P0-3 · npm publish 不应重新编译另一份 executable

当前 npm workflow 下载 raw sidecar 后再次执行 Bun compile。这样 npm 平台包和 Homebrew/GitHub Release 可能来自同一源码/tag，却不是同一二进制候选。

修正：签名、公证和目标平台验证完成后只生成一次 final standalone archive。GitHub Release、npm platform package 和 Homebrew Formula 全部消费该 archive；promotion workflow 只下载、验签/验摘要、解包和封装，不再编译。

### P0-4 · 当前 Formula 安装会破坏 sibling asset 布局

standalone runtime 通过 executable 旁的 `native/` 和 `plugins/` 解析 bundled assets。旧 Formula 仅 `bin.install "volund"`，会丢失 sibling directories；`bin.install_symlink "volund" => "volund"` 还是无意义的自映射。

修正：Homebrew 将完整布局安装到 `libexec`：

```text
libexec/
├── volund
├── native/
├── plugins/
├── checksums.sha256
├── LICENSE
├── NOTICE
└── sbom.cdx.json
```

再通过 `bin.write_exec_script libexec/"volund"` 暴露 `bin/volund`。真实 binary 的 `process.execPath` 因 wrapper exec 指向 `libexec/volund`，bundled native/plugin lookup 仍然自洽。

### P0-5 · packer 可静默发布不完整 target 集

当前 packer 只要求至少发现一个 standalone target；测试甚至以 1～3 个 target 作为成功输入。生产 publish 若下载缺包，仍可能生成一个只覆盖部分平台的 meta package。

修正：production mode 必须精确收到 7 个 executable target：

```text
darwin-arm64
darwin-x64
linux-x64-gnu
linux-arm64-gnu
linux-x64-musl
linux-arm64-musl
win32-x64-msvc
```

Windows arm64 继续由 `win32-x64-msvc` 包经 Prism 覆盖，但必须有真实 Windows arm64 E2E 证据。fixture/单测如需子集，必须显式传 `allowPartialTargets: true`，该参数不得出现在 publish workflow。

### P0-6 · 安装文档与实际包形态冲突

当前安装文档仍称 JavaScript package 首次运行时从 GitHub Release 下载三份 native binary；实际 npm platform package 已包含完整 standalone 布局。两种叙述不能同时作为 canonical 行为。

修正：

- npm/npx/Homebrew：优先使用包内 verified bundled assets，正常运行不依赖首次联网下载；
- GitHub Release 单 binary/manual install：同样携带 sibling assets；
- exact-version download/cache 只作为缺失资源的受控 fallback，并在 `doctor --json` 中标注 source；
- 文档不得把 fallback 描述为标准安装路径。

## 4. 目标分发架构

```text
immutable tag vX.Y.Z + exact commit
              │
              ▼
      build/test/sign/notarize
              │
              ▼
 final standalone archives (one per target)
 + release-manifest.json
 + standalone-checksums.sha256
              │
              ├──────────────► GitHub Release/manual download
              │
              ├─ verify + extract ─► @volund/<triple>
              │                     └─► volund-cli meta ─► npx/npm
              │
              └─ URL + sha256 ─────► Formula/volund.rb ─► Homebrew tap
```

`release-manifest.json` 是多渠道唯一输入，至少包含：

- schema version、product version、tag、commit SHA、build time、Bun version；
- 每个 target 的 archive name、SHA-256、size、executable name；
- archive 内 native manifest digest、SBOM digest、LICENSE/NOTICE digest；
- signing/notarization evidence reference 和 sandbox tier；
- `channelEligible` 不能由“编译成功”自动推导，必须来自 exact candidate 的 release gate decision。

该 manifest 自身必须进入 provenance/attestation，并与 tag commit 绑定。任何 channel promotion 发现 version/tag/commit/digest 不一致时 fail closed。

## 5. 实施阶段

### Phase A · 冻结 final artifact contract（P0）

#### DIST-01 · 统一 standalone archive 内容

- 修改 `scripts/release/build-all-standalone.mjs`：archive 必含 executable、`native/`、`plugins/`、`checksums.sha256`、`LICENSE`、`NOTICE`、`sbom.cdx.json`。
- archive 内部顶层布局固定，不额外套版本目录，便于 npm 解包和 Homebrew `libexec.install`。
- 生成 `standalone-checksums.sha256`，禁止与 sidecar checksum 同名。
- 测试拒绝缺文件、额外 target、重复 target、错 executable name、checksum 不一致。

#### DIST-02 · 新增 release manifest 生成/验证器

- 新增 `scripts/release/generate-release-manifest.mjs` 和测试。
- 输入只能来自 exact built artifacts 和 release evidence，不使用 example.invalid、占位 SHA 或手写 target 列表冒充发布证据。
- `--check` 模式不得写文件；`--release` 模式必须拒绝 placeholder version、dirty source marker 和 blocked evidence。
- 不恢复当前正在删除的旧 L4 dry-run fixtures/evidence matrix。

#### DIST-03 · GitHub Release 不可变上传

- 修改 `.github/workflows/native.yml`：上传前验证 tag/version/commit 和 manifest；去掉对已发布资产的无条件 `--clobber`。
- raw sidecars 与 standalone archives 使用不同 checksum 文件。
- workflow artifact 可覆盖重跑；GitHub Release asset 不可静默覆盖。

**Phase A exit**：给定一个候选 tag，只存在一组可被三个渠道共同引用的 final archive digest。

### Phase B · 完成 npm/npx 包闭环（P0）

#### NPM-01 · 让 packer 只消费 final archives

- 修改 `scripts/release/pack-standalone-npm.mjs`，输入 `release-manifest.json + archives/`。
- 先验证全部 digest，再解包到 platform staging；禁止在 pack/publish 阶段运行 Bun 或 Cargo。
- production 精确验证 7-target set。
- meta package 的 `engines.node` 与文档统一为 `>=20.19.0`；Homebrew binary 不声明 Node 依赖。
- meta package 保留一个 `bin`：`volund`。单一 bin 保证 `npx volund-cli` 可由 npm exec 规则确定执行项。
- 输出 `publish-plan.json` 和每个 package 的 tarball digest。

#### NPM-02 · 修复发布顺序与幂等性

- 修改 `.github/workflows/publish-npm.yml`，从 `publish-plan.json` 逐项发布。
- 顺序：全部 `@volund/<triple>` → `volund-cli` → `volund-code` compatibility package。
- 每次 publish 前执行 registry read：
  - 不存在：允许进入下一步；
  - 已存在且 tarball/integrity 相同：视为幂等重试；
  - 已存在但内容不同：fail closed，禁止复用版本。
- 首发前的 registry/org owner clearance、2FA/trusted publishing、maintainer 列表和 recovery owner 是 human gate。
- stable 发布前先用 `next` dist-tag 验证 prerelease；不得让未经 channel E2E 的版本直接成为 `latest`。

#### NPM-03 · 增加真实 pack/install/npx E2E

最低测试层级：

1. `npm pack --json`：检查 packlist、shebang、executable mode、files、os/cpu/libc、optionalDependencies、license/readme/provenance metadata。
2. local tarball install：在临时 prefix 中安装 meta + 当前平台 package tarball，执行 `.bin/volund --version`、`--help`、`doctor --json`。
3. temporary registry E2E：在 CI 临时 registry 中按真实顺序发布，然后执行：

   ```sh
   npx --yes --registry <temporary-registry> volund-cli@<version> --version
   ```

4. wrapper contract：argv（空格/Unicode/`--`）、stdin/stdout/stderr、exit code、SIGINT/SIGTERM、缺失 optional dependency、unsupported platform、`--omit=optional` 错误提示。
5. 平台矩阵：macOS arm64/x64、Linux glibc x64/arm64、Linux musl x64/arm64、Windows x64、Windows arm64 Prism。cross/QEMU 只能标 partial，不能替代要求的 real-host gate。

**Phase B exit**：临时 registry 的 `npx` E2E 在所有声称支持的平台通过；真实 npm registry 仍需单独 human publish authorization。

### Phase C · 建立生产 Homebrew Formula 与 tap 流程（P1）

#### BREW-01 · 新建专用 Formula generator

- 新增 `scripts/release/generate-homebrew-formula.mjs`，只读取 validated `release-manifest.json`。
- 输出 canonical `Formula/volund.rb` / `class Volund < Formula`，不沿用旧 `volund-code.rb` token。
- 使用 `on_macos` / `on_linux` + `on_arm` / `on_intel` 选择 exact archive URL 和 SHA-256。
- Linuxbrew 只使用 GNU target；musl archive 继续作为 manual/npm target，不误映射到常规 Linuxbrew。
- `def install` 使用 `libexec` 完整保存 sibling assets，再生成 `bin/volund` exec wrapper。
- `test do` 至少断言 `--version`；CI 另跑 `doctor --json` 并断言 sandbox/search/fs 均来自 bundled asset。
- 增加 `livecheck` 只发现稳定 semver tag；prerelease 不自动升级 stable formula。

Formula 不需要再次 build，也不需要第一阶段引入 Homebrew bottles；它安装的是上游已经签名、公证、验证过的 prebuilt archive。以后若选择 bottles，必须作为独立决策，不能与当前 archive digest 混淆。

#### BREW-02 · Tap repo 与 promotion 边界

- 外部仓库建议为 `JS-mark/homebrew-tap`，canonical file 为 `Formula/volund.rb`。
- 用户首选命令：`brew install JS-mark/tap/volund`。安装后 `brew upgrade volund` 正常跟随 tap 更新。
- 主仓库 release promotion 生成 Formula patch/PR；使用只对 tap repo 有写权限的 GitHub App/token。
- 第一阶段采用人工批准的 PR，不从 tag job 直接 push tap main。
- PR 必须绑定主仓库 tag、commit、release-manifest digest 和 Formula digest；review 后只合并已测试的 head SHA。
- `JS-mark/homebrew-tap` 的创建和 push 属外部 mutation，必须另行明确授权。

#### BREW-03 · Homebrew 验收矩阵

每个进入 Formula 的平台都必须在真实 Homebrew 环境执行：

```sh
brew audit --strict --online JS-mark/tap/volund
brew style JS-mark/tap/volund
brew install --verbose JS-mark/tap/volund
volund --version
volund doctor --json
brew test JS-mark/tap/volund
brew uninstall volund
brew install JS-mark/tap/volund
brew upgrade volund
```

最低 GA 覆盖：macOS arm64 + macOS x64。Linux x64 GNU 可在真实 Linuxbrew E2E 通过后进入同一 Formula；Linux arm64 必须等 real-hardware release gate 关闭。未进入 Formula 的平台必须给出明确 unsupported，而不是落到错误 URL。

**Phase C exit**：在未公开 tap 的 staging/fork 上完成 formula audit、install、doctor、upgrade、uninstall；公开 tap 仍需 human authorization。

### Phase D · 文档、观测与发布回滚（P1）

#### DOC-01 · 安装文档只保留真实路径

更新英文/中文：

- `README.md`、`README.zh-CN.md`
- `apps/docs/docs/getting-started/install.md`
- `apps/docs/zh/docs/getting-started/install.md`

明确区分：

- `npx` 是临时下载到 npm cache 后执行，不是持久安装；
- npm/npx 需要 Node.js 20.19+；Homebrew 不需要 Node；
- `@latest` 方便但会漂移，复现问题要固定版本；
- bundled native 是正常路径，download/cache 是 fallback；
- prerelease 使用明确版本或 `@next`，不伪装 stable。

#### OBS-01 · 渠道 smoke 与可观测性

- release summary 记录 GitHub/npm/Homebrew 三渠道 version、digest、promotion time、workflow run、结果。
- 每日/每周只读 smoke 可检查 `npm view`、tap Formula version、URL/digest 和 `--version`，但不得自动发布或自动覆盖资产。
- `doctor --json` 暴露 distribution channel（npm/homebrew/manual 若可可靠识别）、build commit、native source 和 target；无法可靠识别时返回 unknown，禁止猜测。

#### ROLLBACK-01 · 不覆盖版本的回滚

- npm：deprecate/撤下 dist-tag，发布修复版本；不复用旧版本号，不依赖 unpublish 作为常规回滚。
- Homebrew：revert Formula PR 或提交新版本/`revision`，保留 incident 证据；不把旧 URL 改成不同字节。
- GitHub Release：发现 final asset 错误后停止 promotion，发布新版本；不得对已消费的 tag 使用 `--clobber` 替换内容。

## 6. 文件级实施清单

| 文件 | 动作 |
|---|---|
| `scripts/release/build-all-standalone.mjs` | final archive contract、独立 checksum、LICENSE/NOTICE/SBOM |
| `scripts/release/build-all-standalone.test.mjs` | 完整布局、digest、缺失/重复/错 target 负向测试 |
| `scripts/release/generate-release-manifest.mjs` | 新增多渠道唯一 manifest 生成/验证 |
| `scripts/release/generate-release-manifest.test.mjs` | version/tag/commit/digest/evidence fail-closed |
| `scripts/release/pack-standalone-npm.mjs` | 改为消费 final archives；严格 7 target；输出 publish plan |
| `scripts/release/pack-standalone-npm.test.mjs` | npm pack、partial target fence、publish-plan order、wrapper 信号/IO |
| `scripts/release/generate-homebrew-formula.mjs` | 新增 production Formula generator |
| `scripts/release/generate-homebrew-formula.test.mjs` | target mapping、libexec layout、stable/prerelease、Ruby syntax |
| `.github/workflows/native.yml` | final artifact、manifest、不可变 Release upload |
| `.github/workflows/publish-npm.yml` | 不重编、无 glob、严格 publish order、幂等 registry preflight |
| `.github/workflows/homebrew-smoke.yml` | staging Formula audit/install/test matrix；不发布 |
| `scripts/verify-l2-release.test.mjs` | 守卫上述 release ordering 和 no-rebuild/no-clobber 约束 |
| 安装文档四处 | 同步 npx/npm/brew 命令、依赖、版本固定和 fallback 语义 |

不要恢复当前工作树中正在删除的 `channel-dry-run`、L4 placeholder evidence、example.invalid URL 或占位 checksum。新的 generator 必须从真实 candidate manifest 工作，测试 fixture 只能放在测试临时目录或明确命名的 fixture 目录，且不得被 release workflow 接受。

## 7. 验收门

| Gate | npx/npm | Homebrew |
|---|---|---|
| package/formula 静态校验 | `npm pack --json` + manifest assertions | Ruby syntax + `brew style` + `brew audit` |
| 真实安装语义 | temporary registry `npx` + global install | tap staging install |
| bundled assets | `doctor --json` 三项均 bundled | `doctor --json` 三项均 bundled |
| 参数/IO/信号 | argv/stdin/out/err/exit/SIGINT/SIGTERM | wrapper argv/exit/SIGINT |
| 平台 | 7 package targets + Windows ARM Prism evidence | 先 mac arm64/x64；Linux 按 evidence 开启 |
| 供应链 | provenance、exact tarball integrity、registry preflight | immutable URL/SHA、Formula PR exact SHA |
| 更新 | fixed version、`next`→`latest` promotion | install→upgrade→rollback test |
| 外部门禁 | registry owner + publish approval | tap creation/write + signing/notarization approval |

只有上述动态安装证据通过，文档才能写“支持”。代码、workflow、Formula 文件或一次本地 unit test 单独存在，都只能写“已实现/待发布”。

## 8. 推荐执行顺序

```text
DIST-01 → DIST-02 → DIST-03
        → NPM-01 → NPM-02 → NPM-03
        → BREW-01 → BREW-03 → BREW-02
        → DOC-01 → OBS-01 → release human gates
```

首个可执行实现切片建议是一个不触发外部发布的 PR：

1. 修复 checksum 命名冲突和 npm publish glob；
2. 新增 release manifest；
3. 让 npm packer 消费同一 standalone archive；
4. 加 temporary registry `npx` E2E；
5. 生成并在本机/CI 验证 `Formula/volund.rb`，但不创建或推送 tap。

该切片完成后再请求一次 release architecture review；review 通过后，才进入 registry/tap/signing/notarization 的人工授权阶段。
