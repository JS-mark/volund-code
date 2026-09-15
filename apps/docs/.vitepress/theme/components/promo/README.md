# Volund CLI 宣传片（VitePress 主题组件）

宣传视频是一组普通的 VitePress 主题组件，与文档站同栈（纯 Vue 3，无 React/Remotion/额外打包器）：

- **片源**：本目录 `Promo.vue` + `scenes/` 六个场景，文案在 `copy.ts`（`COPY.zh` / `COPY.en`），时间轴在 `timing.ts`。所有动画都是时间 `t`（秒）的纯函数——组件只接收 `t` prop。
- **网页播放**：[`../PromoPlayer.vue`](../PromoPlayer.vue)（首页 promo 区块使用）——rAF 时钟跟随 `audio.currentTime`（天然音画同步），自绘控制条，海报遮罩点击开播，按首页语言自动切换中/英版本。音轨/海报放在 [`../assets/promo/`](../assets/promo/) 并以 vite 哈希 URL 导入（内容变则 URL 变，浏览器不会拿到旧缓存）。
- **终端场景镜像真实 TUI**：`>`绿=用户 / `⏺`青=assistant / `·`灰=system / `◆`灰=活动行；权限卡四选项文案源自 `packages/ui` 的 `PermissionPromptStack`——TUI 文案变更须同步本目录 `copy.ts`。
- **离线出片**（可选，用于社交分发）：`apps/docs` 下跑 `pnpm promo:render`。脚本会构建站点、起静态服务、以 `?promo-capture` 打开首页（播放器切换为全屏固定画布并暴露 `window.volundPromoRender(t)`），playwright 逐帧截图后 ffmpeg 合成 mp4 到 `.promo-work/`。

## 场景

| 时间   | 场景                                           | 组件                       |
| ------ | ---------------------------------------------- | -------------------------- |
| 0–5s   | 开场：像素锤子 logo 组装 + 品牌字标            | `scenes/Opening.vue`       |
| 5–27s  | 终端演示：任务 → 权限审批 → 补丁 → 测试 → 提交 | `scenes/TerminalScene.vue` |
| 27–36s | 控制平面架构：你 → VOLUND → 路由器 → 沙箱      | `scenes/ControlPlane.vue`  |
| 36–48s | 四大特性                                       | `scenes/Features.vue`      |
| 48–58s | 生态：Web 控制台 / 远程网关 / 插件·Skills·MCP  | `scenes/Ecosystem.vue`     |
| 58–66s | CTA：安装命令 + GitHub                         | `scenes/Cta.vue`           |

## 常用命令（apps/docs 下）

```bash
pnpm promo:audio    # 程序化生成 .promo-work/audio-{zh,en}.wav（含打字音效）
pnpm promo:assets   # 网站资产：theme/assets/promo/audio-*.m4a + 海报图
pnpm promo:render   # 出片 mp4 → .promo-work/（需要 ffmpeg；浏览器用 playwright 缓存的 Chromium）
```

## 改动指引

- 改文案：`copy.ts`。英文文案变长时同步调 `typing-plan.json` 的 `cps`，让打字落在 `timing.ts` 既定时间窗内——该文件是音画同步单点，`scripts/promo/gen-audio.mjs` 按它落敲击声（审批 15.2s / 测试通过 17.2s 的提示音与 `timing.ts` 对应）。
- 改完跑 `pnpm promo:assets` 更新网站资产，`vitepress build` 验证。
- `.promo-work/` 是构建产物目录，已 gitignore。
