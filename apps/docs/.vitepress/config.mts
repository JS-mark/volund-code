import { defineConfig } from 'vitepress'

const sharedTheme = {
  logo: '/volund-mark.svg',
  siteTitle: 'VOLUND CLI',
  socialLinks: [{ icon: 'github' as const, link: 'https://github.com/JS-mark/volund-code' }],
  search: {
    provider: 'local' as const,
    options: {
      locales: {
        zh: {
          translations: {
            button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
            modal: {
              noResultsText: '没有找到相关结果',
              resetButtonTitle: '重置搜索',
              footer: { selectText: '选择', navigateText: '切换', closeText: '关闭' },
            },
          },
        },
      },
    },
  },
}

export default defineConfig({
  base: '/volund-code/',
  title: 'Volund CLI',
  description: 'The open, model-agnostic AI coding CLI',
  appearance: true,
  cleanUrls: true,
  ignoreDeadLinks: [/^\.\/(?:\.\.\/)+(?:README|[^/]+\/src\/)/],
  lastUpdated: true,
  sitemap: {
    hostname: 'https://js-mark.com',
    transformItems: (items) =>
      items.map((item) => ({
        ...item,
        url: `/volund-code/${item.url}`,
        links: item.links?.map((link) => ({ ...link, url: `/volund-code/${link.url}` })),
      })),
  },
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: '/volund-code/favicon.svg' }],
    ['meta', { property: 'og:title', content: 'Volund CLI' }],
    ['meta', { property: 'og:description', content: 'The AI coding CLI forged for coders.' }],
    ['meta', { property: 'og:url', content: 'https://js-mark.com/volund-code/' }],
  ],
  locales: {
    root: {
      label: 'English',
      lang: 'en-US',
      title: 'Volund CLI',
      description: 'A permission-first, model-agnostic coding agent for your terminal.',
      themeConfig: {
        ...sharedTheme,
        nav: [
          { text: 'Docs', link: '/docs/getting-started/install' },
          { text: 'Security', link: '/docs/concepts/security-model' },
          { text: 'GitHub', link: 'https://github.com/JS-mark/volund-code' },
        ],
        sidebar: {
          '/docs/': [
            {
              text: 'Getting started',
              items: [
                { text: 'Install', link: '/docs/getting-started/install' },
                { text: 'First run', link: '/docs/getting-started/first-run' },
                { text: '5-minute tutorial', link: '/docs/getting-started/5min-tutorial' },
              ],
            },
            {
              text: 'Concepts',
              items: [
                { text: 'Agent loop', link: '/docs/concepts/agent-loop' },
                { text: 'Security model', link: '/docs/concepts/security-model' },
                { text: 'Skills and vision', link: '/docs/concepts/skills-and-vision' },
              ],
            },
            {
              text: 'Guides',
              items: [
                { text: 'Managing skills', link: '/docs/guides/managing-skills' },
                { text: 'MCP servers', link: '/docs/guides/mcp-servers' },
              ],
            },
            { text: 'API reference', link: '/api/README' },
            { text: 'CLI reference', link: '/docs/reference/cli' },
            {
              text: 'Troubleshooting',
              items: [
                { text: 'Authentication', link: '/docs/troubleshooting/auth' },
                { text: 'Sandbox', link: '/docs/troubleshooting/sandbox' },
                { text: 'Common errors', link: '/docs/troubleshooting/common-errors' },
              ],
            },
          ],
        },
        outline: { label: 'On this page', level: [2, 3] as [number, number] },
        docFooter: { prev: 'Previous', next: 'Next' },
        lastUpdated: { text: 'Last updated' },
      },
    },
    zh: {
      label: '简体中文',
      lang: 'zh-CN',
      link: '/zh/',
      title: 'Volund CLI',
      description: '权限优先、模型无关的终端编程智能体。',
      themeConfig: {
        ...sharedTheme,
        nav: [
          { text: '文档', link: '/zh/docs/getting-started/install' },
          { text: '安全', link: '/zh/docs/concepts/security-model' },
          { text: 'GitHub', link: 'https://github.com/JS-mark/volund-code' },
        ],
        sidebar: {
          '/zh/docs/': [
            {
              text: '快速开始',
              items: [
                { text: '安装', link: '/zh/docs/getting-started/install' },
                { text: '首次运行', link: '/zh/docs/getting-started/first-run' },
                { text: '5 分钟教程', link: '/zh/docs/getting-started/5min-tutorial' },
              ],
            },
            {
              text: '核心概念',
              items: [
                { text: '智能体循环', link: '/zh/docs/concepts/agent-loop' },
                { text: '安全模型', link: '/zh/docs/concepts/security-model' },
                { text: 'Skill 与图像附件', link: '/zh/docs/concepts/skills-and-vision' },
              ],
            },
            {
              text: '使用指南',
              items: [
                { text: '管理 Skill', link: '/zh/docs/guides/managing-skills' },
                { text: '接入 MCP Server', link: '/zh/docs/guides/mcp-servers' },
              ],
            },
            { text: 'API 参考', link: '/api/README' },
            { text: 'CLI 参考', link: '/zh/docs/reference/cli' },
            {
              text: '故障排查',
              items: [
                { text: '身份认证', link: '/zh/docs/troubleshooting/auth' },
                { text: '沙箱', link: '/zh/docs/troubleshooting/sandbox' },
                { text: '常见错误', link: '/zh/docs/troubleshooting/common-errors' },
              ],
            },
          ],
        },
        outline: { label: '本页内容', level: [2, 3] as [number, number] },
        docFooter: { prev: '上一页', next: '下一页' },
        lastUpdated: { text: '最后更新' },
      },
    },
  },
})
