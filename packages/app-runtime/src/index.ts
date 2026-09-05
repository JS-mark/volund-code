/**
 * @volund/app-runtime — UI-neutral 应用组合根（§22.7.1 / Web 计划 P1-02）。
 *
 * 形态：组装产物 = Cordis 内核树（@volund/kernel，S0/S1 已落地）。应用级内核
 * 持有跨会话服务（ui 面板收集器等）；每会话内核挂 model/bus/session（tools、
 * sandbox 在各自装配点以同形态服务挂载）。TUI 与 Web 都是内核外的 adapter，
 * UI 渲染权留在 TCB——UiService 面板收集器是两个界面共用的唯一面板入口。
 *
 * 边界：本包只做组合，不实现 provider/tool/storage 业务；不 import
 * React/Ink/HTTP transport；host 能力（stdin/stdout/readline/浏览器）一律经
 * RuntimeHostPorts 显式注入。
 */
import type { EventBus, SessionState } from '@volund/core'
import { BusService, Context, ModelService, SessionService, UiService } from '@volund/kernel'

export { Context }

/**
 * 界面相关的 host 能力注入口。CLI/TUI adapter 提供 readline/stdout 实现；
 * Web adapter 以审批队列与浏览器会话实现；省略即该能力在当前界面不可用
 * （调用方必须按 undefined 分支降级，而不是假设存在）。
 */
export interface RuntimeHostPorts {
  /** assistant text.delta 的回显（CLI 直写 stdout；Web 省略——delta 只走事件流）。 */
  readonly streamEcho?: ((text: string) => void) | undefined
  /** 行输入（工具 ui.requestInput、dangerous 确认句）。 */
  readonly promptLine?: ((question: string) => Promise<string | undefined>) | undefined
  /** 凭据密语输入（credential store passphrase、login）。 */
  readonly credentialPrompt?: ((prompt: string) => Promise<string | undefined>) | undefined
  /** 打开浏览器（仅 `volund web` 提供）。 */
  readonly openBrowser?: ((url: string) => Promise<void>) | undefined
}

/**
 * AppRuntime 的公共面（P1 逐切片充实：session/permission/config 等 domain
 * controller 以 Cordis service 形态挂进 app 内核后在这里暴露）。
 */
export interface AppRuntime {
  /** 应用级内核（跨会话服务树）。 */
  readonly app: Context
  /** 会话内核工厂；tools/sandbox 服务由调用方在各自装配点挂载。 */
  createSessionKernel(input: { events: EventBus; state: SessionState }): Context
}

/** 应用级内核：跨会话服务（ui 面板收集器等）挂这里。 */
export function createAppKernel(): Context {
  const kernel = new Context()
  kernel.plugin(UiService)
  return kernel
}

/** 会话级内核：model/bus/session 三服务先行，与既有装配顺序一致。 */
export function createSessionKernel(input: { events: EventBus; state: SessionState }): Context {
  const kernel = new Context()
  kernel.plugin(ModelService)
  kernel.plugin(BusService, input.events)
  kernel.plugin(SessionService, input.state)
  return kernel
}

/** 组合根（首切片）：host ports 已接线但尚未有消费方，后续切片逐个接管。 */
export function createAppRuntime(_host: RuntimeHostPorts = {}): AppRuntime {
  return { app: createAppKernel(), createSessionKernel }
}
