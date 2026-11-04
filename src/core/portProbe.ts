import net from 'node:net'
import { execFile } from 'node:child_process'

/**
 * 本地端口在线检测。
 *
 * 内网穿透要真正能用，必须确认两件事同时成立：
 *   1) frpc 进程活着，且已经跟节点握手成功（隧道建立）
 *   2) 本地 Minecraft 端口确实在监听（有服务可以转发过去）
 *
 * 只看 frpc 进程是不够的——frpc 起来了但游戏没开，隧道依然不通。
 * 所以这里独立提供端口探测，UI 用它驱动状态变换动画。
 */

export type PortProbeState = 'online' | 'offline' | 'unknown'

export interface PortProbeResult {
  /** 端口号 */
  port: number
  /** 探测结论 */
  state: PortProbeState
  /** 本次探测耗时（毫秒） */
  latencyMs: number
  /** 探测时刻 */
  at: number
}

/**
 * 主动连接一次本地端口。
 *
 * 用「能否连上」而不是「能否 bind」：bind 成功只能说明端口空闲，
 * 而我们要的是「已经有服务在监听」。connect 成功即说明端口在线。
 * 超时设短一点（默认 800ms），避免拖慢 UI 轮询。
 */
export function probePort(port: number, timeoutMs = 800): Promise<PortProbeResult> {
  const started = Date.now()
  return new Promise((resolve) => {
    let settled = false
    const finish = (state: PortProbeState): void => {
      if (settled) return
      settled = true
      try {
        socket.destroy()
      } catch {
        /* socket 可能已关闭 */
      }
      resolve({ port, state, latencyMs: Date.now() - started, at: Date.now() })
    }

    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(timeoutMs)
    socket.on('connect', () => finish('online'))
    socket.on('timeout', () => finish('offline'))
    socket.on('error', () => finish('offline'))
  })
}

/**
 * 用 netstat 交叉验证端口状态。
 *
 * connect 探测在「端口被防火墙静默丢包」时会误判为 offline，
 * 而 netstat 能看到真实的 LISTENING 记录。两个信号结合更准：
 *   - netstat 有 LISTENING → online
 *   - connect 成功       → online
 *   - 两者都失败         → offline
 */
export function netstatListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    execFile(
      'netstat',
      ['-ano', '-p', 'TCP'],
      { windowsHide: true, timeout: 4000 },
      (err, stdout: string) => {
        if (err) return resolve(false)
        const hit = new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(stdout)
        resolve(hit)
      }
    )
  })
}

/**
 * 综合探测本地端口是否在线。
 *
 * 优先相信 netstat（系统真实状态），
 * netstat 不可用时（非 Windows / 执行失败）退回 connect 探测。
 */
export async function probeLocalPort(port: number, timeoutMs = 800): Promise<PortProbeResult> {
  const started = Date.now()
  const listening = await netstatListening(port)
  if (listening) {
    return { port, state: 'online', latencyMs: Date.now() - started, at: Date.now() }
  }
  const res = await probePort(port, timeoutMs)
  return res
}

/**
 * 连续探测，直到得出确定结论或超时。
 *
 * 启动隧道后端口可能要过一两秒才起来（游戏正在加载），
 * 一次探测就下结论容易误报「离线」，所以给一个短暂的稳定窗口。
 */
export async function waitPortOnline(
  port: number,
  { attempts = 6, intervalMs = 700, timeoutMs = 700 } = {}
): Promise<PortProbeResult> {
  let last: PortProbeResult = { port, state: 'unknown', latencyMs: 0, at: Date.now() }
  for (let i = 0; i < attempts; i++) {
    last = await probeLocalPort(port, timeoutMs)
    if (last.state === 'online') return last
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  return last
}
