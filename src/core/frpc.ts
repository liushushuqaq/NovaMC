import path from 'node:path'
import fs from 'node:fs'
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { fail } from './errors'

/**
 * frpc 内置二进制的定位与进程管理。
 *
 * 两个平台的「快速启动」协议不同，因此内置两份 frpc：
 *   - 樱花（SakuraFrp）：樱花定制版 frpc，支持 `-f <访问密钥>:<隧道ID>` 直接拉取隧道配置。
 *     官方 frpc 没有 -f 参数，必须用樱花定制版。
 *   - 幻缘（ME Frp）：通过 API 拿标准 TOML 配置，用官方 frpc 的 `-c <config.toml>` 启动。
 *     幻缘服务端兼容上游 frpc，官方 frpc 即可连接。
 *
 * 关键点：electron-builder 的 asar 会把 resources 打进 app.asar，
 * Go 二进制没法在 asar 里直接 exec，必须用 asarUnpack 解到 app.asar.unpacked/。
 * 这里优先从 unpacked 目录取，开发模式下退回工程目录。
 */

export type FrpcKind = 'sakura' | 'vanilla'

export interface FrpcLocateResult {
  /** frpc 可执行文件的绝对路径（可能尚不存在） */
  exePath: string
  /** 是否存在（内置或已就绪） */
  exists: boolean
  /** 是否走 asar 解包目录（打包态） */
  unpacked: boolean
}

/** 两份 frpc 在 resources 里的相对目录 */
const FRPC_DIR: Record<FrpcKind, string> = {
  sakura: 'frpc-sakura',
  vanilla: 'frpc'
}

const FRPC_EXE = process.platform === 'win32' ? 'frpc.exe' : 'frpc'

/**
 * 定位指定种类的 frpc 可执行文件。
 * 打包态：resources/app.asar.unpacked/...；开发态：工程根目录 resources/...。
 *
 * 判断依据：打包后 Electron 注入 process.resourcesPath（指向 <exe>/resources），
 * 开发态（electron-vite dev）没有这个变量。
 */
export function locateFrpc(kind: FrpcKind, isPackaged?: boolean): FrpcLocateResult {
  const packaged = isPackaged ?? (typeof process.resourcesPath === 'string' && process.resourcesPath.length > 0)
  const dir = FRPC_DIR[kind]

  if (packaged) {
    const base = path.join(process.resourcesPath, 'app.asar.unpacked', 'resources', dir, FRPC_EXE)
    return { exePath: base, exists: fs.existsSync(base), unpacked: true }
  }

  const dev = path.join(process.cwd(), 'resources', dir, FRPC_EXE)
  return { exePath: dev, exists: fs.existsSync(dev), unpacked: false }
}

/**
 * 把内置的 frpc 确认到磁盘上（asarUnpack 已经做了，这里只是兜底校验 + 返回可用路径）。
 * 不存在时给出明确错误，提示用户重新安装或检查安装包。
 */
export function resolveFrpcExecutable(kind: FrpcKind, isPackaged?: boolean): string {
  const located = locateFrpc(kind, isPackaged)
  if (!located.exists) {
    throw fail('E_FRPC_MISSING', '内置 frpc 没有找到，请重新安装 NovaMC')
  }
  return located.exePath
}

/* ---------------------------------------------------------------- 进程管理 */

export interface FrpcRunOptions {
  /** frpc 可执行文件绝对路径 */
  executable: string
  /** 要传给 frpc 的参数（例如 -f token:id 或 -c config.toml） */
  args: string[]
  cwd?: string
  onLog(line: string): void
  onExit(info: { code: number | null; signal: NodeJS.Signals | null }): void
}

export class FrpcProcess {
  private child: ChildProcess | null = null
  private ring: string[] = []

  get running(): boolean {
    return this.child !== null
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  start(opts: FrpcRunOptions): number {
    if (this.child) throw fail('E_FRPC_RUNNING', 'frpc 已在运行')

    const cwd = opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : undefined
    const child = spawn(opts.executable, opts.args, {
      cwd,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.ring = []

    const push = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue
        this.ring.push(line)
        if (this.ring.length > 300) this.ring.shift()
        opts.onLog(line)
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)

    child.on('error', (e) => {
      opts.onLog(`[frpc] 启动失败：${e.message}`)
    })

    child.on('exit', (code, signal) => {
      this.child = null
      opts.onExit({ code, signal })
    })

    return child.pid ?? 0
  }

  /** 停止 frpc：优先温柔退出，超时强杀 */
  stop(): void {
    const child = this.child
    if (!child?.pid) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (this.child) this.child.kill('SIGKILL')
      }, 3000)
    }
  }

  /** 退出应用时同步强杀 */
  killNow(): void {
    const child = this.child
    if (!child?.pid) return
    if (process.platform === 'win32') {
      try {
        const { spawnSync } = require('node:child_process') as typeof import('node:child_process')
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 4000 })
      } catch {
        /* 进程可能已退出 */
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已退出 */
      }
    }
    this.child = null
  }

  /** 取最近日志片段，排查上线失败用 */
  tail(lines = 40): string[] {
    return this.ring.slice(-lines)
  }
}
