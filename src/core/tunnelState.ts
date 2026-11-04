import type { PortProbeResult } from './portProbe'

/**
 * 隧道状态机。
 *
 * 用户的核心诉求是「启动隧道要有状态变换动画」，这就要求状态不只是
 * running=true/false 两个值，而是一条有语义、可驱动动画的链路：
 *
 *   idle ──启动──▶ starting ──日志出现握手成功──▶ online
 *                      │                              │
 *                      │                          端口探测
 *                      ▼                              ▼
 *                    error ◀──进程退出──      online(隧道通) 但 portOffline(游戏没开)
 *                                                      │
 *                                          游戏启动 → 端口探测成功
 *                                                      ▼
 *                                                  ready（完全就绪）
 *
 * 其中 online 表示「隧道已建立」，ready 表示「隧道已建立且本地端口在线」，
 * 只有 ready 才是真正能联机的状态。
 */
export type TunnelPhase =
  | 'idle' // 空闲，未启动
  | 'starting' // 正在拉起 frpc
  | 'connecting' // frpc 已启动，正在与节点握手
  | 'online' // 隧道已建立，但本地端口还没在线
  | 'ready' // 隧道已建立且本地端口在线——可以联机了
  | 'offline' // 隧道建立但本地端口掉线（游戏关了）
  | 'error' // 启动失败 / 进程异常退出
  | 'stopping' // 正在停止

export interface TunnelPhaseInfo {
  phase: TunnelPhase
  /** 面向用户的状态标题 */
  label: string
  /** 面向用户的补充说明 */
  hint: string
  /** 是否属于「进行中」——UI 会给它转圈动画 */
  pending: boolean
  /** 是否属于「已就绪」——UI 会给它绿色高亮与呼吸动画 */
  ready: boolean
  /** 是否属于「异常」——UI 会给它红色警示 */
  failed: boolean
}

const PHASE_META: Record<TunnelPhase, Omit<TunnelPhaseInfo, 'phase'>> = {
  idle: {
    label: '待机',
    hint: '选择一条隧道后启动',
    pending: false,
    ready: false,
    failed: false
  },
  starting: {
    label: '启动中',
    hint: '正在拉起 frpc 进程',
    pending: true,
    ready: false,
    failed: false
  },
  connecting: {
    label: '连接中',
    hint: '正在与穿透节点握手',
    pending: true,
    ready: false,
    failed: false
  },
  online: {
    label: '已上线',
    hint: '隧道已建立，等待游戏端口上线',
    pending: false,
    ready: false,
    failed: false
  },
  ready: {
    label: '可联机',
    hint: '隧道与游戏端口都已就绪',
    pending: false,
    ready: true,
    failed: false
  },
  offline: {
    label: '端口离线',
    hint: '游戏未运行或端口未监听',
    pending: false,
    ready: false,
    failed: false
  },
  error: {
    label: '启动失败',
    hint: '请查看下方日志排查',
    pending: false,
    ready: false,
    failed: true
  },
  stopping: {
    label: '停止中',
    hint: '正在关闭隧道',
    pending: true,
    ready: false,
    failed: false
  }
}

export function phaseInfo(phase: TunnelPhase): TunnelPhaseInfo {
  return { phase, ...PHASE_META[phase] }
}

/**
 * 从 frpc 日志里判断当前处于哪个阶段。
 *
 * frpc 的日志格式两个平台差异很大，都实测过：
 *   - 官方 frpc（幻缘用）：英文，如 "login to server success" / "login to the server failed"
 *   - 樱花定制版 frpc：中文为主，如 "[401] 访问密钥无效" / "访问密钥长度错误" / "Bad fetch parameter"
 * 所以这里中英文都要覆盖，否则失败时 UI 会一直卡在「启动中」。
 *
 * 匹配策略是宽松的关键词命中，因为不同 frpc 版本/魔改版的措辞不完全一致。
 */
export function detectPhaseFromLog(line: string): TunnelPhase | null {
  const l = line.toLowerCase()
  const raw = line

  /* ---------------------------------------------------- 失败信号（优先判断） */
  // 官方 frpc 英文失败
  if (
    l.includes('login to the server failed') ||
    l.includes('authorization failed') ||
    l.includes('auth failed') ||
    l.includes('invalid token') ||
    l.includes('token expired') ||
    l.includes('no such tunnel') ||
    l.includes('connection refused') ||
    l.includes('i/o timeout')
  ) {
    return 'error'
  }
  // 樱花定制版中文失败
  if (
    raw.includes('访问密钥无效') ||
    raw.includes('访问密钥长度错误') ||
    raw.includes('隧道不存在') ||
    raw.includes('隧道已存在') ||
    raw.includes('启动失败') ||
    raw.includes('连接失败') ||
    raw.includes('认证失败') ||
    raw.includes('节点不存在') ||
    raw.includes('端口被占用') ||
    raw.includes('额度不足') ||
    raw.includes('隧道已过期')
  ) {
    return 'error'
  }
  // 通用英文失败词（放在中文之后，避免误伤正常日志）
  if (l.includes('access key') || l.includes('not found') || l.includes('failed')) {
    return 'error'
  }
  // 樱花返回的错误码格式：[401] / [403] 等
  if (/^\[\s*(4\d\d|5\d\d)\s*\]/.test(raw.trim())) {
    return 'error'
  }
  // 拉取配置失败（樱花的 -f 模式会先拉配置）
  if (l.includes('bad fetch parameter') || l.includes('fetch config failed')) {
    return 'error'
  }

  /* ---------------------------------------------------- 隧道建立成功 */
  if (
    l.includes('login to server success') ||
    l.includes('start proxy success') ||
    l.includes('proxy start success') ||
    raw.includes('启动成功') ||
    raw.includes('连接成功')
  ) {
    return 'online'
  }

  /* ---------------------------------------------------- 正在连接 */
  if (
    l.includes('login to server') ||
    l.includes('connecting to server') ||
    l.includes('try to connect') ||
    l.includes('dial to') ||
    raw.includes('连接中') ||
    raw.includes('正在连接')
  ) {
    return 'connecting'
  }

  return null
}

/**
 * 综合 frpc 进程状态、日志与端口探测结果，算出当前阶段。
 *
 * @param running frpc 进程是否存活
 * @param logPhase 从最近日志里解析出的阶段（可能是 null）
 * @param probe 本地端口探测结果（可能为 null）
 * @param hadError 上一次是否已经判定为失败
 */
export function resolvePhase(input: {
  running: boolean
  logPhase: TunnelPhase | null
  probe: PortProbeResult | null
  hadError: boolean
  stopping?: boolean
  /** frpc 进程是否已经退出 */
  exited?: boolean
}): TunnelPhase {
  const { running, logPhase, probe, hadError, stopping, exited } = input

  if (stopping) return 'stopping'
  if (!running) {
    // 进程已经退出：要么明确失败过，要么是退出即失败（例如下面紧跟一行 [401] 就退出）
    return hadError ? 'error' : 'idle'
  }

  // 隧道已建立（日志确认）时，再看端口状态
  if (logPhase === 'online' || logPhase === 'ready') {
    if (!probe) return 'online'
    return probe.state === 'online' ? 'ready' : 'online'
  }

  if (logPhase === 'error') return 'error'
  if (logPhase === 'connecting') return 'connecting'
  if (logPhase === 'starting') return 'starting'

  // 进程活着但没解析到关键日志：处于启动初期
  // 若进程其实已经退出过，说明启动失败了
  if (exited) return 'error'

  return 'starting'
}
