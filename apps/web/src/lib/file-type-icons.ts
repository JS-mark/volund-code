/**
 * 文件类型徽章映射（资源管理器图标；VS Code Seti 图标主题的轻量替代）:
 * 文件名精确表优先,其次扩展名表;未命中返回 undefined(调用方回落默认文件图标)。
 */
export interface FileTypeBadge {
  /** 徽章字符(1-2 位,16px 方格内可读)。 */
  label: string
  /** 主色(徽章文字色;背景由组件派生为 12% 透明度同色)。 */
  color: string
}

const FILENAME_BADGES: Record<string, FileTypeBadge> = {
  dockerfile: { label: 'DK', color: '#2496ed' },
  makefile: { label: 'MK', color: '#6d8086' },
  'cmakelists.txt': { label: 'CM', color: '#6d8086' },
  'package.json': { label: 'N', color: '#cb3837' },
  'pnpm-lock.yaml': { label: 'LK', color: '#6d8086' },
  'package-lock.json': { label: 'LK', color: '#6d8086' },
  'yarn.lock': { label: 'LK', color: '#6d8086' },
  '.gitignore': { label: 'G', color: '#f05033' },
  '.gitattributes': { label: 'G', color: '#f05033' },
  '.gitmodules': { label: 'G', color: '#f05033' },
  '.env': { label: 'E', color: '#b58900' },
  license: { label: '§', color: '#6d8086' },
}

const EXTENSION_BADGES: Record<string, FileTypeBadge> = {
  ts: { label: 'TS', color: '#3178c6' },
  tsx: { label: 'TS', color: '#3178c6' },
  mts: { label: 'TS', color: '#3178c6' },
  cts: { label: 'TS', color: '#3178c6' },
  js: { label: 'JS', color: '#b7950b' },
  jsx: { label: 'JS', color: '#b7950b' },
  mjs: { label: 'JS', color: '#b7950b' },
  cjs: { label: 'JS', color: '#b7950b' },
  json: { label: '{}', color: '#6e7681' },
  jsonc: { label: '{}', color: '#6e7681' },
  md: { label: 'MD', color: '#519aba' },
  mdx: { label: 'MD', color: '#519aba' },
  py: { label: 'PY', color: '#3572a5' },
  pyi: { label: 'PY', color: '#3572a5' },
  html: { label: '<>', color: '#e34c26' },
  htm: { label: '<>', color: '#e34c26' },
  vue: { label: '<>', color: '#41b883' },
  svelte: { label: '<>', color: '#ff3e00' },
  css: { label: '#', color: '#2965f1' },
  scss: { label: '#', color: '#c6538c' },
  less: { label: '#', color: '#1d365d' },
  xml: { label: '<>', color: '#8a63d2' },
  svg: { label: '<>', color: '#8a63d2' },
  yml: { label: 'Y', color: '#cb3837' },
  yaml: { label: 'Y', color: '#cb3837' },
  toml: { label: '⚙', color: '#6d8086' },
  ini: { label: '⚙', color: '#6d8086' },
  conf: { label: '⚙', color: '#6d8086' },
  cfg: { label: '⚙', color: '#6d8086' },
  sh: { label: '>_', color: '#4eaa25' },
  bash: { label: '>_', color: '#4eaa25' },
  zsh: { label: '>_', color: '#4eaa25' },
  ps1: { label: '>_', color: '#2671be' },
  go: { label: 'GO', color: '#00add8' },
  rs: { label: 'RS', color: '#b7410e' },
  java: { label: 'J', color: '#b07219' },
  kt: { label: 'KT', color: '#7f52ff' },
  kts: { label: 'KT', color: '#7f52ff' },
  c: { label: 'C', color: '#00599c' },
  h: { label: 'C', color: '#00599c' },
  cpp: { label: 'C+', color: '#00599c' },
  cc: { label: 'C+', color: '#00599c' },
  cxx: { label: 'C+', color: '#00599c' },
  hpp: { label: 'C+', color: '#00599c' },
  cs: { label: 'C#', color: '#178600' },
  swift: { label: 'SW', color: '#f05138' },
  php: { label: 'P', color: '#777bb4' },
  rb: { label: 'RB', color: '#cc342d' },
  sql: { label: 'DB', color: '#e38c00' },
  graphql: { label: '◆', color: '#e535ab' },
  gql: { label: '◆', color: '#e535ab' },
  lua: { label: 'L', color: '#5151a1' },
  dart: { label: 'D', color: '#0175c2' },
  r: { label: 'R', color: '#198ce7' },
  tf: { label: 'TF', color: '#7b42bc' },
  tfvars: { label: 'TF', color: '#7b42bc' },
  hcl: { label: 'TF', color: '#7b42bc' },
  proto: { label: 'PB', color: '#6e7681' },
  dockerfile: { label: 'DK', color: '#2496ed' },
  png: { label: 'IM', color: '#a074c4' },
  jpg: { label: 'IM', color: '#a074c4' },
  jpeg: { label: 'IM', color: '#a074c4' },
  gif: { label: 'IM', color: '#a074c4' },
  webp: { label: 'IM', color: '#a074c4' },
  ico: { label: 'IM', color: '#a074c4' },
  bmp: { label: 'IM', color: '#a074c4' },
  lock: { label: 'LK', color: '#6d8086' },
  log: { label: '≡', color: '#6e7681' },
  txt: { label: '≡', color: '#6e7681' },
}

/** 文件名/扩展名 → 徽章;未命中 undefined(隐藏文件首点不当扩展名分隔符)。 */
export function fileTypeBadge(name: string): FileTypeBadge | undefined {
  const lower = name.toLowerCase()
  const byName = FILENAME_BADGES[lower]
  if (byName) return byName
  if (lower.startsWith('dockerfile.')) return FILENAME_BADGES['dockerfile']
  if (lower.startsWith('.env')) return FILENAME_BADGES['.env']
  const dot = lower.lastIndexOf('.')
  if (dot <= 0) return undefined
  return EXTENSION_BADGES[lower.slice(dot + 1)]
}
