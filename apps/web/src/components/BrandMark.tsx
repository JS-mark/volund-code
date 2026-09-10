/**
 * 品牌像素锤标（与 apps/docs/public/volund-mark.svg 同一几何，内联避免额外资产请求）。
 * 颜色走 --volund-mark-* CSS 变量：浅色主题用官方深色底，深色主题反转为青底，
 * 否则深色页面上 #06100f 底与背景融为一体、看不到图标块。
 */
export function BrandMark({ size = 32 }: { size?: number }) {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="Volund"
      style={{ display: 'block', borderRadius: size * 0.28 }}
    >
      <rect width="64" height="64" rx="8" fill="var(--volund-mark-bg)" />
      <path fill="var(--volund-mark-fg)" d="M10 7H54V13H60V40H54V46H37V59H27V46H10V40H4V13H10Z" />
      <rect x="14" y="17" width="36" height="19" fill="var(--volund-mark-bg)" />
      <path
        fill="var(--volund-mark-fg)"
        d="M18 20H22V23H25V26H28V29H25V32H22V35H18V32H21V29H24V26H21V23H18Z"
      />
      <rect x="34" y="32" width="10" height="3" fill="var(--volund-mark-fg)" />
    </svg>
  )
}
