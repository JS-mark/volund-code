import getAccessibilityServiceOverride from '@codingame/monaco-vscode-accessibility-service-override'
/**
 * 内嵌 VS Code workbench(monaco-vscode-api,vscode-web 同源代码的 npm 形态)。
 *
 * 与 serve-web 方案的区别:零子进程、零下载,全部代码随页面 chunk 走本地分发;
 * 文件系统经 RestFileSystemProvider 桥到 workbench REST,读写的就是真实工作区。
 *
 * 约束:
 * - initialize 全页只能调一次(AppShell 让代码页常驻挂载,不随路由卸载);
 * - 本模块体积大,只能经 next/dynamic(ssr:false) 按需加载;
 * - worker 全部走同源打包产物(CSP worker-src 回落 script-src 'self' 即放行)。
 */
import { initialize, LogLevel } from '@codingame/monaco-vscode-api'
import type { IWorkbenchConstructionOptions } from '@codingame/monaco-vscode-api'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import getAuthenticationServiceOverride from '@codingame/monaco-vscode-authentication-service-override'
import getConfigurationServiceOverride from '@codingame/monaco-vscode-configuration-service-override'
import getDialogsServiceOverride from '@codingame/monaco-vscode-dialogs-service-override'
import getEnvironmentServiceOverride from '@codingame/monaco-vscode-environment-service-override'
import getExplorerServiceOverride from '@codingame/monaco-vscode-explorer-service-override'
import getExtensionGalleryServiceOverride from '@codingame/monaco-vscode-extension-gallery-service-override'
import getExtensionServiceOverride from '@codingame/monaco-vscode-extensions-service-override'
import getFilesServiceOverride from '@codingame/monaco-vscode-files-service-override'
import { registerFileSystemOverlay } from '@codingame/monaco-vscode-files-service-override'
import getKeybindingsServiceOverride from '@codingame/monaco-vscode-keybindings-service-override'
import getLanguagesServiceOverride from '@codingame/monaco-vscode-languages-service-override'
import getLifecycleServiceOverride from '@codingame/monaco-vscode-lifecycle-service-override'
import getLogServiceOverride from '@codingame/monaco-vscode-log-service-override'
import getMarkersServiceOverride from '@codingame/monaco-vscode-markers-service-override'
import getModelServiceOverride from '@codingame/monaco-vscode-model-service-override'
import getNotificationServiceOverride from '@codingame/monaco-vscode-notifications-service-override'
import getOutputServiceOverride from '@codingame/monaco-vscode-output-service-override'
import getPreferencesServiceOverride from '@codingame/monaco-vscode-preferences-service-override'
import getQuickAccessServiceOverride from '@codingame/monaco-vscode-quickaccess-service-override'
import getScmServiceOverride from '@codingame/monaco-vscode-scm-service-override'
import getSearchServiceOverride from '@codingame/monaco-vscode-search-service-override'
import getSnippetServiceOverride from '@codingame/monaco-vscode-snippets-service-override'
import getStorageServiceOverride from '@codingame/monaco-vscode-storage-service-override'
import getTelemetryServiceOverride from '@codingame/monaco-vscode-telemetry-service-override'
import getTextmateServiceOverride from '@codingame/monaco-vscode-textmate-service-override'
import getThemeServiceOverride from '@codingame/monaco-vscode-theme-service-override'
import getBannerServiceOverride from '@codingame/monaco-vscode-view-banner-service-override'
import getStatusBarServiceOverride from '@codingame/monaco-vscode-view-status-bar-service-override'
import getTitleBarServiceOverride from '@codingame/monaco-vscode-view-title-bar-service-override'
import getWalkThroughServiceOverride from '@codingame/monaco-vscode-walkthrough-service-override'
import getWelcomeServiceOverride from '@codingame/monaco-vscode-welcome-service-override'
import getWorkbenchServiceOverride from '@codingame/monaco-vscode-workbench-service-override'
import getWorkingCopyServiceOverride from '@codingame/monaco-vscode-working-copy-service-override'
import getWorkspaceTrustOverride from '@codingame/monaco-vscode-workspace-trust-service-override'
// 默认扩展(side-effect 注册):全语言 TextMate 语法 + 官方主题 + Seti 文件图标 +
// ts/json/css/html/md 语言特性 + 常用内置(merge-conflict/references-view/media-preview…)。
import '@codingame/monaco-vscode-all-language-default-extensions'
import '@codingame/monaco-vscode-theme-defaults-default-extension'
import '@codingame/monaco-vscode-theme-seti-default-extension'
import '@codingame/monaco-vscode-typescript-language-features-default-extension'
import '@codingame/monaco-vscode-json-language-features-default-extension'
import '@codingame/monaco-vscode-css-language-features-default-extension'
import '@codingame/monaco-vscode-html-language-features-default-extension'
import '@codingame/monaco-vscode-markdown-language-features-default-extension'
import '@codingame/monaco-vscode-merge-conflict-default-extension'
import '@codingame/monaco-vscode-references-view-default-extension'
import '@codingame/monaco-vscode-media-preview-default-extension'
import '@codingame/monaco-vscode-search-result-default-extension'
import '@codingame/monaco-vscode-configuration-editing-default-extension'
import 'vscode/localExtensionHost'

import type { WebApi } from './api'
import { RestFileSystemProvider } from './vscode-fs-provider'

// worker 装配:label 是 vscode 内部服务约定(见 monaco-vscode-api demo)。
self.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string): Worker {
    switch (label) {
      case 'TextMateWorker':
        return new Worker(
          new URL('@codingame/monaco-vscode-textmate-service-override/worker', import.meta.url),
          { type: 'module' },
        )
      case 'OutputLinkDetectionWorker':
        return new Worker(
          new URL('@codingame/monaco-vscode-output-service-override/worker', import.meta.url),
          { type: 'module' },
        )
      case 'LocalFileSearchWorker':
        return new Worker(
          new URL('@codingame/monaco-vscode-search-service-override/worker', import.meta.url),
          { type: 'module' },
        )
      case 'extensionHostWorkerMain':
        return new Worker(
          new URL('@codingame/monaco-vscode-api/workers/extensionHost.worker', import.meta.url),
          { type: 'module' },
        )
      default:
        return new Worker(
          new URL('monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
          {
            type: 'module',
          },
        )
    }
  },
}

export interface StartVscodeWorkbenchOptions {
  container: HTMLElement
  /** 工作区真实绝对路径(挂载为 file://<cwd>)。 */
  cwd: string
  api: WebApi
  dark: boolean
}

// initialize 全局只能一次:模块级单例,重复进入代码页直接复用。
let bootPromise: Promise<void> | undefined

export function startVscodeWorkbench(options: StartVscodeWorkbenchOptions): Promise<void> {
  bootPromise ??= boot(options)
  return bootPromise
}

async function boot({ container, cwd, api, dark }: StartVscodeWorkbenchOptions): Promise<void> {
  // 文件系统桥:真实工作区(逃逸由桥内换算 + 服务端 resolveWithin 双保险)。
  registerFileSystemOverlay(1, new RestFileSystemProvider(api, cwd))

  const constructionOptions: IWorkbenchConstructionOptions = {
    // 工作区是用户自己的 cwd:不做 Workspace Trust 弹窗/受限模式。
    enableWorkspaceTrust: false,
    workspaceProvider: {
      trusted: true,
      workspace: { folderUri: URI.file(cwd) },
      async open() {
        return true
      },
    },
    configurationDefaults: {
      'workbench.colorTheme': dark ? 'Default Dark Modern' : 'Default Light Modern',
      'telemetry.telemetryLevel': 'off',
      'window.title': '${activeEditorShort}${separator}Volund Code',
    },
    developmentOptions: { logLevel: LogLevel.Warning },
    productConfiguration: {
      nameShort: 'Volund Code',
      nameLong: 'Volund Code — VS Code for the Web',
    },
  }

  await initialize(
    {
      ...getAccessibilityServiceOverride(),
      ...getAuthenticationServiceOverride(),
      ...getBannerServiceOverride(),
      ...getConfigurationServiceOverride(),
      ...getDialogsServiceOverride(),
      ...getEnvironmentServiceOverride(),
      ...getExplorerServiceOverride(),
      ...getExtensionServiceOverride({ enableWorkerExtensionHost: true }),
      ...getExtensionGalleryServiceOverride({ webOnly: false }),
      ...getFilesServiceOverride(),
      ...getKeybindingsServiceOverride(),
      ...getLanguagesServiceOverride(),
      ...getLifecycleServiceOverride(),
      ...getLogServiceOverride(),
      ...getMarkersServiceOverride(),
      ...getModelServiceOverride(),
      ...getNotificationServiceOverride(),
      ...getOutputServiceOverride(),
      ...getPreferencesServiceOverride(),
      ...getQuickAccessServiceOverride({
        isKeybindingConfigurationVisible: () => true,
        shouldUseGlobalPicker: () => true,
      }),
      ...getScmServiceOverride(),
      ...getSearchServiceOverride(),
      ...getSnippetServiceOverride(),
      ...getStatusBarServiceOverride(),
      ...getStorageServiceOverride(),
      ...getTelemetryServiceOverride(),
      ...getTextmateServiceOverride(),
      ...getThemeServiceOverride(),
      ...getTitleBarServiceOverride(),
      ...getWelcomeServiceOverride(),
      ...getWalkThroughServiceOverride(),
      ...getWorkbenchServiceOverride(),
      ...getWorkingCopyServiceOverride(),
      ...getWorkspaceTrustOverride(),
    },
    container,
    constructionOptions,
    // 不把它当用户 home:避免「首个工作区目录被当 home」的误检(见 demo 注释)。
    { userHome: URI.file('/') },
  )
}
