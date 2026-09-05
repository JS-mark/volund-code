# volund-plugin-ts-demo

TypeScript 插件入口示例：`manifest.json` 写 `"main": "index.ts"`，源码即产物。

## 要点

- **Node ≥ 22.6**：宿主以 `--experimental-strip-types` 装载 TS 入口；类型擦除只支持
  可静态擦除的子集（interface / 类型标注 / 泛型 ✓；enum / namespace / 参数属性 ✗，
  用到的插件请先编译成 JS）。
- **零运行时依赖**：`import type { VolundBridge } from '@volund/plugin-sdk'` 会在装载
  时被整体擦除，沙箱里不需要 node_modules。
- **工具名写裸名**：`'ts-count'` 由宿主自动收敛为
  `plugin:volund-plugin-ts-demo:ts-count`。

## 运行

```bash
ln -s "$PWD/examples/plugins/volund-plugin-ts-demo" ~/.volund/plugins-dev/
# 或 VOLUND_DEV_PLUGINS="$PWD/examples/plugins" volund
```

让模型"数一下这段文字的词数"即可触发 `ts-count` 工具。姊妹示例
[`volund-plugin-demo`](../volund-plugin-demo/)（JS）覆盖全部五种贡献面
（工具 / hooks / prompt / 会话事件 / 斜杠命令）。
