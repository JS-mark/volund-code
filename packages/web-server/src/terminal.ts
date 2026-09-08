/**
 * 工作台终端的交互式 shell 会话。
 *
 * 零原生依赖的 PTY 方案（按平台分支，实测拓扑见包内测试）：
 * - darwin：`expect -c 'spawn -noecho SHELL; …; interact'`。macOS 自带
 *   /usr/bin/expect；BSD script(1) 不可用——它对 socketpair/fifo stdin 的
 *   tcgetattr 直接报 ENOTSUP 退出，且父进程持有 pty slave 导致 shell 退出后
 *   script 不退（exit 事件丢失）。expect 的 interact 在子进程退出时干净退出。
 *   expect 脚本额外：启动时向 stderr 打 `VOLUND_PTY:<slave-path>` 标记（服务端
 *   解析后剥出不进数据流）+ 立刻 stty 初始尺寸——无 tty 上下文时 pty winsize
 *   是 0x0，zsh/p10k 在 0 列下会画出 '%' 残影。初始尺寸须用前端握手带的
 *   真实值（不能先 80x24 再改）：shell 初始化途中改尺寸会触发 SIGWINCH 重绘，
 *   清屏序列按旧几何计算、新几何下擦不干净——留下重复提示行 + '%' 残帧。
 *   resize 经 `stty -f <slave> rows R columns C` 实现（触发 SIGWINCH，shell
 *   自动重绘）；与当前尺寸相同的 resize 直接跳过，避免多余 SIGWINCH。
 * - linux：util-linux `script -qec SHELL /dev/null` 容忍非 tty stdin 且在
 *   子进程退出时退出（SIGCHLD 驱动，与 BSD 行为不同）；初始尺寸经
 *   `stty …; exec SHELL` 预设（script 的 -c 走 sh -c），之后的 resize 无通道
 *   （no-op）。
 * - win32：无 PTY 等价物，退化为管道 cmd.exe（流式但无行编辑/全屏应用）。
 *
 * 设置（[web.terminal] config）：shell 覆盖、fontSize、scrollback 由装配侧
 * 读合并配置注入；fontSize/scrollback 只经 bootstrap 透传给前端。
 */
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface TerminalSession {
  /** 写入按键/粘贴数据（原样进 shell stdin）。 */
  write(data: string): void
  /** 尺寸变更（darwin 经 stty -f 落到 pty 并触发 SIGWINCH；其余平台 no-op）。
   * 与当前尺寸相同的调用直接跳过——重复 stty 会在 shell 初始化途中多打一次
   * SIGWINCH，p10k 重绘几何变化会留下残帧。 */
  resize(cols: number, rows: number): void
  kill(): void
  onData(cb: (data: string) => void): void
  onExit(cb: (code: number | null) => void): void
}

/** 建连时的初始尺寸（WS 握手 query 带入）；缺省 80x24。 */
export interface TerminalSize {
  cols: number
  rows: number
}

export interface TerminalSettings {
  /** 实际生效的 shell（[web.terminal].shell 覆盖 > $SHELL > /bin/sh；win32 cmd.exe）。 */
  shell: string
  fontSize: number
  scrollback: number
}

export interface TerminalPort {
  readonly settings: TerminalSettings
  spawnShell(size?: TerminalSize): TerminalSession
}

/** 单引号 shell 转义（'foo' → 'foo'\''bar' 形式）。 */
const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`

const DEFAULT_COLS = 80
const DEFAULT_ROWS = 24

/** 初始尺寸边界：异常/超界输入回退 80x24（WS query 是外部输入）。 */
const normalizeSize = (size?: TerminalSize): Required<TerminalSize> => {
  const cols = size?.cols
  const rows = size?.rows
  return {
    cols: Number.isInteger(cols) && cols! >= 1 && cols! <= 500 ? cols! : DEFAULT_COLS,
    rows: Number.isInteger(rows) && rows! >= 1 && rows! <= 200 ? rows! : DEFAULT_ROWS,
  }
}

/** resize 输入校验：非正整数/超界一律忽略（不能回退默认值——误改几何会触发重绘）。 */
const validSize = (cols: number, rows: number): boolean =>
  Number.isInteger(cols) &&
  Number.isInteger(rows) &&
  cols >= 1 &&
  cols <= 500 &&
  rows >= 1 &&
  rows <= 200

/** expect 脚本：spawn PTY → stderr 打 slave 路径标记 → 预设初始尺寸 → interact。 */
const expectScript = (shell: string, cols: number, rows: number): string =>
  `spawn -noecho {${shell}}\n` +
  `puts stderr "VOLUND_PTY:$spawn_out(slave,name)"\n` +
  `stty rows ${rows} columns ${cols} < $spawn_out(slave,name)\n` +
  'interact'

export function createTerminalPort(
  cwd: string,
  options: { shell?: string; fontSize?: number; scrollback?: number } = {},
): TerminalPort {
  const isWin = process.platform === 'win32'
  const shell =
    options.shell && !isWin
      ? options.shell
      : process.env.SHELL && !isWin
        ? process.env.SHELL
        : isWin
          ? 'cmd.exe'
          : '/bin/sh'
  const settings: TerminalSettings = {
    shell,
    fontSize: options.fontSize ?? 12,
    scrollback: options.scrollback ?? 2000,
  }
  return {
    settings,
    spawnShell(size) {
      const initial = normalizeSize(size)
      const useExpect = !isWin && process.platform === 'darwin' && existsSync('/usr/bin/expect')
      const [command, args] = isWin
        ? [shell, [] as string[]]
        : useExpect
          ? // Tcl 大括号包裹：shell 路径原样进 spawn（空格安全）。
            ['expect', ['-c', expectScript(shell, initial.cols, initial.rows)]]
          : process.platform === 'darwin'
            ? ['sh', ['-c', `cat | script -q /dev/null ${shQuote(shell)}`]]
            : // script -c 走 sh -c：先 stty 预设初始尺寸再 exec shell（slave 即 stdin）。
              [
                'script',
                [
                  '-qec',
                  `stty rows ${initial.rows} columns ${initial.cols}; exec ${shQuote(shell)}`,
                  '/dev/null',
                ],
              ]
      // detached：独立进程组，kill 时 SIGHUP 整组（cat/script/shell 一勺烩）。
      const child = spawn(command!, args, {
        cwd,
        env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
        stdio: ['pipe', 'pipe', 'pipe'],
        ...(isWin ? {} : { detached: true }),
      })
      let dataCb: ((data: string) => void) | undefined
      let exitCb: ((code: number | null) => void) | undefined
      let exited = false
      // 当前 pty 尺寸：resize 与现值相同时跳过 stty（避免多余 SIGWINCH 重绘残帧）。
      let currentCols = initial.cols
      let currentRows = initial.rows
      const fireExit = (code: number | null) => {
        if (exited) return
        exited = true
        exitCb?.(code)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => dataCb?.(chunk))
      // stderr：expect 的 VOLUND_PTY 标记行被剥出（其余诊断照常进数据流）。
      let ptyPath: string | undefined
      let stderrBuf = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        if (ptyPath !== undefined) {
          dataCb?.(chunk)
          return
        }
        stderrBuf += chunk
        const marker = stderrBuf.match(/VOLUND_PTY:(\/\S+)/)
        if (marker) {
          ptyPath = marker[1]
          const rest = stderrBuf.slice(stderrBuf.indexOf(marker[0]) + marker[0].length + 1)
          stderrBuf = ''
          if (rest) dataCb?.(rest)
        }
      })
      child.on('exit', (code) => fireExit(code))
      child.on('error', () => fireExit(null))
      return {
        write(data) {
          if (child.stdin.writable) child.stdin.write(data)
        },
        resize(cols, rows) {
          if (!ptyPath || isWin || !validSize(cols, rows)) return
          if (cols === currentCols && rows === currentRows) return
          currentCols = cols
          currentRows = rows
          // stty -f/-F 落到 slave pty：改 winsize 并向前台进程组发 SIGWINCH。
          execFile(
            'stty',
            [
              process.platform === 'darwin' ? '-f' : '-F',
              ptyPath,
              'rows',
              String(rows),
              'columns',
              String(cols),
            ],
            () => {},
          )
        },
        kill() {
          try {
            child.stdin.destroy()
          } catch {
            // 已关闭
          }
          if (isWin) {
            child.kill()
            return
          }
          try {
            process.kill(-child.pid!, 'SIGHUP')
          } catch {
            child.kill('SIGHUP')
          }
          setTimeout(() => {
            try {
              process.kill(-child.pid!, 'SIGKILL')
            } catch {
              // 组已消失
            }
          }, 500).unref()
        },
        onData(cb) {
          dataCb = cb
        },
        onExit(cb) {
          exitCb = cb
          if (exited) queueMicrotask(() => cb(null))
        },
      }
    },
  }
}
