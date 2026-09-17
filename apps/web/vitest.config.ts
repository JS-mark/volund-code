import { defineConfig } from 'vitest/config'

// Next.js tsconfig 固定 `"jsx": "preserve"`（App Router 编译器要求）；
// vitest 需要把 JSX 真正转译成 createElement 才能在 node 环境跑组件渲染测试。
export default defineConfig({
  oxc: { jsx: 'automatic' },
})
