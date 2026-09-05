<script setup>
import { withBase } from 'vitepress'
import { computed } from 'vue'

import VolundScene from './VolundScene.vue'

const props = defineProps({ locale: { type: String, default: 'en' } })
const isZh = computed(() => props.locale === 'zh')
const localizedPath = (path) => withBase(`${isZh.value ? '/zh' : ''}${path}`)

const copy = {
  en: {
    release: 'VOLUND CLI · OPEN SOURCE',
    title: 'The AI coding CLI',
    titleAccent: 'forged for coders.',
    lede: 'Volund is a model-agnostic AI coding CLI for your terminal. Bring the provider. Keep the context. Approve every side effect.',
    docs: 'Read the docs',
    source: 'View source',
    preRelease: 'pre-release',
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
    startBody: 'Read the five-minute guide, inspect every permission, and make one small change.',
    startAction: 'Run the first task ↗',
    footer: 'Open source · Apache-2.0 · Telemetry local by default',
    footerDocs: 'Docs',
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
    startBody: '阅读五分钟教程，检查每一项权限，然后完成一个小而明确的改动。',
    startAction: '运行第一个任务 ↗',
    footer: '开源 · Apache-2.0 · 遥测默认保留在本地',
    footerDocs: '文档',
    footerSecurity: '安全',
  },
}

const t = computed(() => copy[isZh.value ? 'zh' : 'en'])
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
            <p>
              <span class="term-muted">14:08:31</span>
              <span class="term-accent">volund</span> analyze the failing test
            </p>
            <p class="term-system">◆ Reading repository context <span>12 files</span></p>
            <p class="term-system">◆ Provider selected <span>anthropic / claude</span></p>
            <p class="term-spacer"></p>
            <p><span class="term-accent">→</span> I found the regression in the stream decoder.</p>
            <p>The final UTF-8 boundary is flushed before the abort state.</p>
            <div class="permission-row">
              <div><small>PERMISSION REQUEST</small><strong>write · src/stream.ts</strong></div>
              <span>review</span>
            </div>
            <p class="term-system">◆ Patch applied <span>+8 −3</span></p>
            <p class="term-system">◆ Tests passed <span>5 / 5</span></p>
            <p class="terminal-cursor"><span class="term-accent">›</span> <i></i></p>
          </div>
        </div>
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
      <div>
        <p>{{ t.startBody }}</p>
        <a class="primary-action" :href="localizedPath('/docs/getting-started/5min-tutorial')">
          {{ t.startAction }}
        </a>
      </div>
    </section>

    <footer class="volund-footer">
      <a class="footer-brand" :href="localizedPath('/')">
        <img :src="withBase('/volund-mark.svg')" alt="" width="28" height="28" />
        <span>VOLUND CLI</span>
      </a>
      <p>{{ t.footer }}</p>
      <div>
        <a :href="localizedPath('/docs/getting-started/install')">{{ t.footerDocs }}</a>
        <a href="https://github.com/JS-mark/volund-code/blob/main/SECURITY.md">{{
          t.footerSecurity
        }}</a>
        <a href="https://github.com/JS-mark/volund-code">GitHub</a>
      </div>
    </footer>
  </main>
</template>
