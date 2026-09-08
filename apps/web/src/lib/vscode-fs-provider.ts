/**
 * workbench REST ↔ vscode FileSystemProvider 桥（内嵌 workbench 的文件读写通道）。
 * - workspace 以真实绝对路径挂载（file://<cwd>/…），桥内换算为 posix 相对路径走 API；
 *   越出 cwd 的访问抛 NoPermissions（服务端 resolveWithin 还有一道硬门）；
 * - 无服务端变更推送：watch 为空实现（保存/新建后 vscode 自己重 stat，刷新树用 F5）；
 * - 错误映射到 FileSystemProviderError，vscode 按语义展示（NotFound/Unavailable…）。
 */
import { Emitter, Event } from '@codingame/monaco-vscode-api/vscode/vs/base/common/event'
import { Disposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import type { IDisposable } from '@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle'
import { URI } from '@codingame/monaco-vscode-api/vscode/vs/base/common/uri'
import {
  FileSystemProviderCapabilities,
  FileSystemProviderError,
  FileSystemProviderErrorCode,
  FileType,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'
import type {
  IFileChange,
  IFileDeleteOptions,
  IFileOverwriteOptions,
  IFileSystemProviderWithFileReadWriteCapability,
  IFileWriteOptions,
  IStat,
  IWatchOptions,
} from '@codingame/monaco-vscode-api/vscode/vs/platform/files/common/files'

import type { WebApi } from './api'

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function bytesToBase64(content: Uint8Array): string {
  // 分块避免栈溢出（大文件 string 拼接慢,但写场景远小于读场景,够用）。
  let binary = ''
  const CHUNK = 0x8000
  for (let index = 0; index < content.length; index += CHUNK) {
    binary += String.fromCharCode(...content.subarray(index, index + CHUNK))
  }
  return btoa(binary)
}

/** API 错误 → vscode FS 语义。 */
function toFsError(resource: URI, cause: unknown): FileSystemProviderError {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/not found/i.test(message))
    return FileSystemProviderError.create(message, FileSystemProviderErrorCode.FileNotFound)
  if (/escapes the workspace/i.test(message))
    return FileSystemProviderError.create(message, FileSystemProviderErrorCode.NoPermissions)
  if (/target exists/i.test(message))
    return FileSystemProviderError.create(message, FileSystemProviderErrorCode.FileExists)
  return FileSystemProviderError.create(message, FileSystemProviderErrorCode.Unavailable)
}

export class RestFileSystemProvider implements IFileSystemProviderWithFileReadWriteCapability {
  readonly capabilities = FileSystemProviderCapabilities.FileReadWrite
  readonly onDidChangeCapabilities: Event<void> = Event.None
  private readonly emitter = new Emitter<readonly IFileChange[]>()
  readonly onDidChangeFile: Event<readonly IFileChange[]> = this.emitter.event

  constructor(
    private readonly api: WebApi,
    private readonly cwd: string,
  ) {}

  /** file://<cwd>/a/b.ts → a/b.ts（posix 相对）;越界/非 file 协议 → NoPermissions。 */
  private rel(resource: URI): string {
    if (resource.scheme !== 'file')
      throw FileSystemProviderError.create(
        `unsupported scheme: ${resource.scheme}`,
        FileSystemProviderErrorCode.NoPermissions,
      )
    const path = resource.path
    const prefix = this.cwd.endsWith('/') ? this.cwd : `${this.cwd}/`
    if (path !== this.cwd && !path.startsWith(prefix))
      throw FileSystemProviderError.create(
        `outside workspace: ${path}`,
        FileSystemProviderErrorCode.NoPermissions,
      )
    return path === this.cwd ? '' : path.slice(prefix.length)
  }

  watch(_resource: URI, _options: IWatchOptions): IDisposable {
    return Disposable.None
  }

  async stat(resource: URI): Promise<IStat> {
    try {
      const stat = await this.api.wbStat(this.rel(resource))
      return {
        type:
          stat.kind === 'dir'
            ? FileType.Directory
            : stat.kind === 'file'
              ? FileType.File
              : FileType.Unknown,
        ctime: stat.mtimeMs,
        mtime: stat.mtimeMs,
        size: stat.size,
      }
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async readdir(resource: URI): Promise<[string, FileType][]> {
    try {
      const { entries } = await this.api.wbListDir(this.rel(resource))
      return entries.map((entry) => [
        entry.name,
        entry.kind === 'dir'
          ? FileType.Directory
          : entry.kind === 'file'
            ? FileType.File
            : FileType.Unknown,
      ])
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async readFile(resource: URI): Promise<Uint8Array> {
    try {
      const bytes = await this.api.wbReadBytes(this.rel(resource))
      return base64ToBytes(bytes.base64)
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async writeFile(resource: URI, content: Uint8Array, _options: IFileWriteOptions): Promise<void> {
    try {
      await this.api.wbWriteBytes(this.rel(resource), bytesToBase64(content))
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async mkdir(resource: URI): Promise<void> {
    try {
      await this.api.wbMkdir(this.rel(resource))
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async delete(resource: URI, options: IFileDeleteOptions): Promise<void> {
    try {
      await this.api.wbDelete(this.rel(resource), options.recursive)
    } catch (cause) {
      throw toFsError(resource, cause)
    }
  }

  async rename(from: URI, to: URI, options: IFileOverwriteOptions): Promise<void> {
    try {
      // 服务端 rename 不覆盖;vscode 的 overwrite 语义 = 先删后移。
      if (options.overwrite) await this.api.wbDelete(this.rel(to), true).catch(() => {})
      await this.api.wbRename(this.rel(from), this.rel(to))
    } catch (cause) {
      throw toFsError(from, cause)
    }
  }
}
