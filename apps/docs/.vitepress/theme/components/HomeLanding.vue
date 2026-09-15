<script setup>
import { withBase } from 'vitepress'
import { computed } from 'vue'

import { COPY } from './promo/copy'
import plan from './promo/typing-plan.json'
import PromoPlayer from './PromoPlayer.vue'
import VolundScene from './VolundScene.vue'

const props = defineProps({ locale: { type: String, default: 'en' } })
const isZh = computed(() => props.locale === 'zh')
const localizedPath = (path) => withBase(`${isZh.value ? '/zh' : ''}${path}`)
/* Hero terminal mirrors the real TUI transcript (promo copy is the source of truth). */
const heroTerm = computed(() => COPY[isZh.value ? 'zh' : 'en'].term)
const heroCmd = computed(() => plan[isZh.value ? 'zh' : 'en'].cmd1)

const copy = {
  en: {
    release: 'VOLUND CLI · OPEN SOURCE',
    title: 'The AI coding CLI',
    titleAccent: 'forged for coders.',
    lede: 'Volund is a model-agnostic AI coding CLI for your terminal. Bring the provider. Keep the context. Approve every side effect.',
    docs: 'Read the docs',
    source: 'View source',
    preRelease: 'pre-release',
    videoLabel: 'PROMO REEL',
    videoTitle: 'Volund in 66 seconds.',
    videoNote: 'From task to permission approval, patch, and green tests — one take, sound on.',
    principles: ['Any model', 'Local context', 'Explicit permissions', 'Rust sandbox'],
    controlLabel: 'THE CONTROL PLANE',
    controlTitle: 'One agent.\nNo black box.',
    controlBody:
      'Volund separates reasoning from execution. Models can propose. The permission layer decides. The sandbox contains. Every step stays visible in your terminal.',
    securityLink: 'Explore the security model →',
    rail: [
      ['YOU', 'intent'],
      ['VOLUND', 'context + loop'],
      ['ROUTER', 'your provider'],
      ['SANDBOX', 'controlled action'],
    ],
    featureLabel: 'BUILT FOR THE TERMINAL',
    featureTitle: 'The parts that matter\nare yours.',
    features: [
      [
        'Provider-neutral',
        'Route through a stable contract. Change the model without changing how you work.',
      ],
      [
        'Permission-first',
        'Writes, commands, and network access ask before they happen. Denial is a normal path.',
      ],
      [
        'Local by default',
        'Sessions and diagnostics remain on your machine unless you explicitly opt in.',
      ],
      [
        'Open end to end',
        'TypeScript orchestration and a Rust safety core. Read it, audit it, extend it.',
      ],
    ],
    startLabel: 'START WITH CONTEXT',
    startTitle: 'Your repo.\nYour rules.',
    startBody:
      'Three steps to your first supervised change — every write, command, and network call asks before it happens.',
    startSteps: [
      ['Install the CLI', 'npm install --global @volund/cli', '/docs/getting-started/install'],
      ['Open your repo', 'cd your-repo && volund', '/docs/getting-started/first-run'],
      [
        'Run the first task',
        'volund "fix the failing test"',
        '/docs/getting-started/5min-tutorial',
      ],
    ],
    footerTagline: 'Open source · Apache-2.0 · Telemetry local by default',
    footerCols: [
      {
        title: 'Docs',
        links: [
          ['Install', '/docs/getting-started/install'],
          ['First run', '/docs/getting-started/first-run'],
          ['5-minute tutorial', '/docs/getting-started/5min-tutorial'],
        ],
      },
      {
        title: 'Guides',
        links: [
          ['Managing skills', '/docs/guides/managing-skills'],
          ['MCP servers', '/docs/guides/mcp-servers'],
          ['Remote gateway', '/docs/guides/remote-gateway'],
        ],
      },
      {
        title: 'Reference',
        links: [
          ['CLI reference', '/docs/reference/cli'],
          ['API reference', '/api/README'],
          ['Security model', '/docs/concepts/security-model'],
        ],
      },
      {
        title: 'Project',
        links: [
          ['GitHub', 'https://github.com/JS-mark/volund-code'],
          ['Releases', 'https://github.com/JS-mark/volund-code/releases'],
          ['Issues', 'https://github.com/JS-mark/volund-code/issues'],
          ['License', 'https://github.com/JS-mark/volund-code/blob/main/LICENSE'],
        ],
      },
    ],
    footerSecurity: 'Security',
  },
  zh: {
    release: 'VOLUND CLI · 开源',
    title: '为 coder 锻造的',
    titleAccent: 'AI 编程 CLI。',
    lede: 'Volund 是运行在终端中的模型无关 AI 编程 CLI。自选模型，保留上下文，每一个副作用都由你确认。',
    docs: '阅读文档',
    source: '查看源码',
    preRelease: '预发布',
    videoLabel: '宣传视频',
    videoTitle: '一分钟，看懂 Volund。',
    videoNote: '从下达任务到权限审批、补丁落地、测试通过 —— 66 秒一镜到底，建议开启声音。',
    principles: ['任意模型', '本地上下文', '显式权限', 'Rust 沙箱'],
    controlLabel: '控制平面',
    controlTitle: '一个智能体。\n没有黑箱。',
    controlBody:
      'Volund 将推理与执行分离：模型负责提出方案，权限层负责决策，沙箱负责隔离。每一步都清晰呈现在终端中。',
    securityLink: '了解安全模型 →',
    rail: [
      ['你', '任务意图'],
      ['VOLUND', '上下文 + 循环'],
      ['路由器', '你的模型'],
      ['沙箱', '受控执行'],
    ],
    featureLabel: '为终端而生',
    featureTitle: '重要的部分，\n都属于你。',
    features: [
      ['模型无关', '使用稳定的统一契约切换模型，不必改变工作方式。'],
      ['权限优先', '写文件、执行命令与访问网络都会先询问；拒绝是正常流程。'],
      ['默认本地', '会话与诊断默认保留在本机，只有明确选择才会发送。'],
      ['全链路开源', 'TypeScript 编排配合 Rust 安全内核，可阅读、可审计、可扩展。'],
    ],
    startLabel: '从上下文开始',
    startTitle: '你的仓库。\n你的规则。',
    startBody: '三步完成第一个受监督的改动——每次写文件、跑命令、访问网络，都会先经过你的确认。',
    startSteps: [
      ['安装 CLI', 'npm install --global @volund/cli', '/docs/getting-started/install'],
      ['进入你的仓库', 'cd your-repo && volund', '/docs/getting-started/first-run'],
      ['跑通第一个任务', 'volund "修复那个失败的测试"', '/docs/getting-started/5min-tutorial'],
    ],
    footerTagline: '开源 · Apache-2.0 · 遥测默认保留在本地',
    footerCols: [
      {
        title: '文档',
        links: [
          ['安装', '/docs/getting-started/install'],
          ['首次运行', '/docs/getting-started/first-run'],
          ['5 分钟教程', '/docs/getting-started/5min-tutorial'],
        ],
      },
      {
        title: '指南',
        links: [
          ['管理 Skill', '/docs/guides/managing-skills'],
          ['接入 MCP Server', '/docs/guides/mcp-servers'],
          ['远程网关', '/docs/guides/remote-gateway'],
        ],
      },
      {
        title: '参考',
        links: [
          ['CLI 参考', '/docs/reference/cli'],
          ['API 参考', '/api/README'],
          ['安全模型', '/docs/concepts/security-model'],
        ],
      },
      {
        title: '项目',
        links: [
          ['GitHub', 'https://github.com/JS-mark/volund-code'],
          ['发布记录', 'https://github.com/JS-mark/volund-code/releases'],
          ['问题反馈', 'https://github.com/JS-mark/volund-code/issues'],
          ['许可证', 'https://github.com/JS-mark/volund-code/blob/main/LICENSE'],
        ],
      },
    ],
    footerSecurity: '安全',
  },
}

const t = computed(() => copy[isZh.value ? 'zh' : 'en'])
const year = new Date().getFullYear()
// API 参考不在 zh 前缀下（双语共用一份 typedoc 产物），仅 /docs 路径走本地化。
const footerHref = (href) => (href.startsWith('/docs') ? localizedPath(href) : href)
</script>

<template>
  <main class="volund-home">
    <section class="hero-grid" aria-labelledby="hero-title">
      <div class="hero-copy">
        <div class="release-kicker">
          <span class="status-dot" aria-hidden="true"></span>
          {{ t.release }}
        </div>
        <h1 id="hero-title">
          {{ t.title }}<br /><span>{{ t.titleAccent }}</span>
        </h1>
        <p class="hero-lede">{{ t.lede }}</p>
        <div class="hero-actions">
          <a class="primary-action" :href="localizedPath('/docs/getting-started/install')">
            {{ t.docs }} <span aria-hidden="true">↗</span>
          </a>
          <a class="text-action" href="https://github.com/JS-mark/volund-code">
            {{ t.source }} <span aria-hidden="true">→</span>
          </a>
        </div>
        <div class="install-command" aria-label="Installation command">
          <span class="prompt-mark">$</span>
          <code>npm install --global @volund/cli</code>
          <span class="command-note">{{ t.preRelease }}</span>
        </div>
      </div>

      <div class="hero-visual" aria-label="Volund terminal session preview">
        <VolundScene />
        <div class="terminal-shell">
          <div class="terminal-bar">
            <div class="terminal-controls" aria-hidden="true"><i></i><i></i><i></i></div>
            <span>volund · ~/workspace</span>
            <span class="terminal-tier">TIER / FULL</span>
          </div>
          <div class="terminal-body">
            <p class="term-shell-line"><span class="term-shell-prompt">❯</span> {{ heroCmd }}</p>
            <p class="term-agent">
              <span class="term-mk mk-agent">⏺</span> {{ heroTerm.assistant1 }}
            </p>
            <p class="term-agent-wrap">{{ heroTerm.assistant2 }}</p>
            <p class="term-act">◆ {{ heroTerm.readDone }}<span> · 1.1s</span></p>
            <p class="term-act">◆ {{ heroTerm.editDone }}<span> · +8 −3</span></p>
            <div class="permission-card">
              <p class="perm-title">
                {{ heroTerm.permTitle }} <span>· {{ heroTerm.permTool }}</span>
              </p>
              <p class="perm-spec">
                <em>{{ heroTerm.permSpecGutter }}</em
                >{{ heroTerm.permFile }}<span>{{ heroTerm.permSpecSuffix }}</span>
              </p>
              <p class="perm-opt focused">
                <i>&gt;</i><b>1</b><span class="perm-lbl">{{ heroTerm.permOptions[0].label }}</span>
                <span class="perm-hint">{{ heroTerm.permOptions[0].hint }}</span>
              </p>
              <p class="perm-opt">
                <i>&nbsp;</i><b>2</b
                ><span class="perm-lbl">{{ heroTerm.permOptions[1].label }}</span>
                <span class="perm-hint">{{ heroTerm.permOptions[1].hint }}</span>
              </p>
              <p class="perm-foot">{{ heroTerm.permFooter }}</p>
            </div>
            <p class="term-act">◆ {{ heroTerm.testDone }}<span> · 5/5 ✓</span></p>
            <p class="terminal-cursor"><span class="term-accent">›</span> <i></i></p>
          </div>
        </div>
      </div>
    </section>

    <section class="promo-section" aria-labelledby="promo-title">
      <div class="section-intro">
        <span class="eyebrow">{{ t.videoLabel }}</span>
        <h2 id="promo-title">{{ t.videoTitle }}</h2>
      </div>
      <div class="promo-copy">
        <p>{{ t.videoNote }}</p>
      </div>
      <div class="promo-frame">
        <div class="terminal-bar">
          <div class="terminal-controls" aria-hidden="true"><i></i><i></i><i></i></div>
          <span>volund · promo</span>
          <span class="promo-length">66s</span>
        </div>
        <ClientOnly>
          <PromoPlayer :locale="isZh ? 'zh' : 'en'" />
        </ClientOnly>
      </div>
    </section>

    <section class="signal-strip" aria-label="Product principles">
      <p v-for="(principle, index) in t.principles" :key="principle">
        <span>0{{ index + 1 }}</span> {{ principle }}
      </p>
    </section>

    <section class="control-section" aria-labelledby="control-title">
      <div class="section-intro">
        <span class="eyebrow">{{ t.controlLabel }}</span>
        <h2 id="control-title">{{ t.controlTitle }}</h2>
      </div>
      <div class="control-copy">
        <p>{{ t.controlBody }}</p>
        <a :href="localizedPath('/docs/concepts/security-model')">{{ t.securityLink }}</a>
      </div>
      <div class="architecture-rail" role="img" aria-label="Volund CLI system flow">
        <template v-for="(node, index) in t.rail" :key="node[0]">
          <div class="rail-node" :class="{ 'rail-user': index === 0, 'rail-sandbox': index === 3 }">
            <span>0{{ index + 1 }}</span
            ><strong>{{ node[0] }}</strong
            ><small>{{ node[1] }}</small>
          </div>
          <div v-if="index < 3" class="rail-line"><i></i></div>
        </template>
      </div>
    </section>

    <section class="feature-ledger" aria-labelledby="feature-title">
      <div class="ledger-heading">
        <span class="eyebrow">{{ t.featureLabel }}</span>
        <h2 id="feature-title">{{ t.featureTitle }}</h2>
      </div>
      <article v-for="(feature, index) in t.features" :key="feature[0]">
        <span class="feature-index">A / 0{{ index + 1 }}</span>
        <h3>{{ feature[0] }}</h3>
        <p>{{ feature[1] }}</p>
      </article>
    </section>

    <section class="closing-callout">
      <div>
        <span class="eyebrow">{{ t.startLabel }}</span>
        <h2>{{ t.startTitle }}</h2>
      </div>
      <div class="start-panel">
        <p>{{ t.startBody }}</p>
        <ol class="start-steps">
          <li v-for="(step, index) in t.startSteps" :key="step[0]">
            <a :href="localizedPath(step[2])">
              <span class="step-index">0{{ index + 1 }}</span>
              <span class="step-detail">
                <strong>{{ step[0] }}</strong>
                <code>{{ step[1] }}</code>
              </span>
              <span class="step-arrow" aria-hidden="true">→</span>
            </a>
          </li>
        </ol>
      </div>
    </section>

    <footer class="volund-footer">
      <div class="footer-sitemap">
        <div class="footer-brand-col">
          <a class="footer-brand" :href="localizedPath('/')">
            <img :src="withBase('/volund-mark.svg')" alt="" width="28" height="28" />
            <span>VOLUND CLI</span>
          </a>
          <p class="footer-tagline">{{ t.footerTagline }}</p>
        </div>
        <nav
          v-for="col in t.footerCols"
          :key="col.title"
          class="footer-col"
          :aria-label="col.title"
        >
          <strong>{{ col.title }}</strong>
          <a v-for="link in col.links" :key="link[0]" :href="footerHref(link[1])">{{ link[0] }}</a>
        </nav>
      </div>
      <div class="footer-bottom">
        <p>© {{ year }} Volund contributors</p>
        <div class="footer-legal">
          <a href="https://github.com/JS-mark/volund-code/blob/main/SECURITY.md">{{
            t.footerSecurity
          }}</a>
          <a href="https://github.com/JS-mark/volund-code">GitHub</a>
        </div>
      </div>
    </footer>
  </main>
</template>
