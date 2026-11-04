import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useApp, invoke } from '../store'
import { Icon } from '../icons'
import { Empty } from '../components'
import type {
  TunnelAccountInfo,
  TunnelPhase,
  TunnelProviderId,
  TunnelStatus,
  TunnelSummary
} from '@core/types'
import type { ReactElement } from 'react'

interface ProviderMeta {
  id: TunnelProviderId
  label: string
  desc: string
  /** 用户在哪里拿访问凭据 */
  tokenHint: string
  /** 官方文档地址 */
  docUrl: string
}

const PROVIDERS: ProviderMeta[] = [
  {
    id: 'sakura',
    label: '樱花内网穿透',
    desc: 'SakuraFrp · 国内节点多',
    // 樱花的 API 认证用的是「访问密钥」（Bearer Token），官方 spec 里
    // securitySchemes.UserToken 的描述就是「访问密钥认证」。
    // 之前 UI 写「访问令牌」会让人填错东西。
    tokenHint: '在 SakuraFrp 官网「用户中心 → 访问密钥」复制密钥（不是客户端的 -f 密钥）',
    docUrl: 'https://doc.natfrp.com/'
  },
  {
    id: 'mefrp',
    label: '幻缘内网穿透',
    desc: 'ME Frp · 幻缘映射',
    tokenHint: '在幻缘映射官网的 API 令牌页获取 Bearer Token',
    docUrl: 'https://apidoc.mefrp.com/'
  },
  {
    id: 'hayfrp',
    label: 'HayFrp',
    // HayFrp 没有可复制的 API Token，只能用账号登录换 CSRF，
    // 所以这一家的凭据是「账号 + 密码」，弹窗里会给两个输入框。
    desc: 'HayFrp · hayfrp.com',
    tokenHint: 'HayFrp 的开放接口用账号登录换取凭据，这里填 HayFrp 的账号和密码',
    docUrl: 'https://docs.hayfrp.com/'
  }
]

/**
 * HayFrp 的凭据在本地存成 {"user","passwd"}，比「账号:密码」拼串稳，
 * 也不会因为密码里带冒号被截断。这两个函数负责拆/装。
 */
function readHayCredential(raw: string): { user: string; passwd: string } {
  if (!raw.trim()) return { user: '', passwd: '' }
  try {
    const o = JSON.parse(raw) as { user?: string; passwd?: string }
    if (o.user || o.passwd) return { user: o.user ?? '', passwd: o.passwd ?? '' }
  } catch {
    /* 手填过 账号:密码 的情况，往下兜底 */
  }
  const i = raw.indexOf(':')
  if (i > 0) return { user: raw.slice(0, i).trim(), passwd: raw.slice(i + 1) }
  return { user: raw.trim(), passwd: '' }
}

function writeHayCredential(user: string, passwd: string): string {
  return JSON.stringify({ user: user.trim(), passwd })
}

/**
 * 复制到剪贴板。
 *
 * 打包态页面是 file:// 协议，不算安全上下文，`navigator.clipboard` 可能拿不到，
 * 所以留一条 textarea + execCommand 的老路兜底。
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    /* 走兜底 */
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.top = '0'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/** MB → 人类可读（1 TB 以上也扛得住） */
function formatMb(mb: number | undefined): string | null {
  if (mb === undefined || !Number.isFinite(mb)) return null
  if (mb >= 1024 * 1024) return `${(mb / 1024 / 1024).toFixed(1)} TB`
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`
}

/** Mbps → 文案 */
function formatMbps(v: number | undefined): string | null {
  if (v === undefined || !Number.isFinite(v) || v <= 0) return null
  return v >= 1000 ? `${(v / 1000).toFixed(1)} Gbps` : `${Number(v.toFixed(1))} Mbps`
}

/**
 * 状态轨道上的四个阶段。
 * UI 用它把「当前在第几步」画成一条连续的进度链路，
 * 这样用户能看到状态是在推进还是卡住。
 */
const TRACK_STEPS: { phase: TunnelPhase; label: string }[] = [
  { phase: 'starting', label: '启动' },
  { phase: 'connecting', label: '握手' },
  { phase: 'online', label: '隧道' },
  { phase: 'ready', label: '就绪' }
]

/** 阶段在轨道上的序号（-1 表示不在轨道上） */
function trackIndex(phase: TunnelPhase): number {
  const i = TRACK_STEPS.findIndex((s) => s.phase === phase)
  return i
}

/** 阶段徽章的样式类 */
function badgeClass(phase: TunnelPhase): string {
  switch (phase) {
    case 'starting':
    case 'connecting':
    case 'stopping':
      return 'pending'
    case 'ready':
      return 'ready'
    case 'error':
      return 'failed'
    case 'online':
      return 'online'
    default:
      return 'idle'
  }
}

/** 阶段文案 */
function phaseLabel(phase: TunnelPhase): string {
  switch (phase) {
    case 'starting':
      return '启动中'
    case 'connecting':
      return '连接中'
    case 'online':
      return '隧道已上线'
    case 'ready':
      return '可以联机了'
    case 'offline':
      return '端口离线'
    case 'error':
      return '启动失败'
    case 'stopping':
      return '停止中'
    default:
      return '待机'
  }
}

export default function TunnelPage(): ReactElement {
  const config = useApp((s) => s.config)
  const notify = useApp((s) => s.notify)

  const [providerId, setProviderId] = useState<TunnelProviderId>('sakura')
  const [token, setToken] = useState('')
  const [tunnels, setTunnels] = useState<TunnelSummary[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [starting, setStarting] = useState(false)
  const [status, setStatus] = useState<TunnelStatus | null>(null)
  const [tokenOpen, setTokenOpen] = useState(false)

  // 账号概况：剩余流量 / 带宽 / 隧道数，三家字段口径不同，主进程已归一
  const [account, setAccount] = useState<TunnelAccountInfo | null>(null)

  // 令牌弹窗里的草稿值，与已保存值分离
  const [draftToken, setDraftToken] = useState('')
  // HayFrp 专用：账号 + 密码两个字段
  const [draftUser, setDraftUser] = useState('')
  const [draftPass, setDraftPass] = useState('')

  // 记录上一次的状态，用于判断「状态是否刚发生变化」来触发动画
  const prevPhase = useRef<TunnelPhase>('idle')

  // 已经自动拉取过的「平台 + 凭据」组合，防止重复拉取
  const autoPulled = useRef<Set<string>>(new Set())

  // 平台 -> 最近一次拉到的隧道列表。
  // 切回已经拉过的平台时直接复用，既不用重新请求，也不会出现空列表。
  const tunnelCache = useRef<Record<string, TunnelSummary[]>>({})

  const savedToken = config?.tunnelTokens?.[providerId] ?? ''

  /**
   * 回填已保存的凭据。
   *
   * 这里必须等 config 加载完成再回填：config 是异步取的，
   * 若在它到达之前就按 providerId 填一次，之后不会再触发，
   * 就会出现「明明配过凭据，切页回来又要重填」。
   * 用 configLoaded 标记确保只在拿到 config 后回填一次。
   */
  const configLoaded = Boolean(config)

  const refreshStatus = useCallback(async (): Promise<void> => {
    const st = await invoke(() => window.nova.tunnel.status(), '读取隧道状态失败')
    if (st) setStatus(st)
  }, [])

  /**
   * 拉账号概况（剩余流量 / 带宽 / 隧道数）。
   *
   * 这个接口有的平台要额外权限，失败就静默不显示那一排统计，
   * 不能因为读不到流量就把隧道本身也拦住。
   */
  const loadAccount = useCallback(
    async (credential: string, provider: TunnelProviderId): Promise<void> => {
      if (!credential.trim()) {
        setAccount(null)
        return
      }
      try {
        const res = await window.nova.tunnel.account(provider, credential.trim())
        setAccount(res.ok ? res.data : null)
      } catch {
        setAccount(null)
      }
    },
    []
  )

  /**
   * 拉取隧道列表。
   *
   * 自动拉取的时机有三处，都走这一个函数：
   *   1. 平台切换后（有凭据就自动拉）
   *   2. 首次进入页面且已有凭据
   *   3. 用户在弹窗里保存凭据后
   *
   * autoKey 用来防重复：同一个平台 + 同一份凭据只自动拉一次，
   * 否则 config 对象引用一变（每次 reload 都是新对象）就会反复拉取。
   */
  const pullTunnels = useCallback(
    async (
      credential: string,
      provider: TunnelProviderId,
      silent = false,
      autoKey?: string
    ): Promise<void> => {
      if (!credential.trim()) return
      // 自动拉取的幂等守卫
      if (autoKey) {
        if (autoPulled.current.has(autoKey)) return
        autoPulled.current.add(autoKey)
      }
      setLoading(true)
      const list = await invoke(
        () => window.nova.tunnel.list(provider, credential.trim()),
        '拉取隧道失败'
      )
      setLoading(false)
      if (!list) {
        // 静默模式（自动拉取）不弹错误，避免每次进页面都弹一次
        if (!silent) notify('error', '拉取隧道失败', '请检查凭据是否正确')
        return
      }
      setTunnels(list)
      tunnelCache.current[provider] = list
      setSelectedId(null)
      if (!silent) {
        if (list.length === 0) {
          notify('info', '没有找到隧道', '请先到平台上创建一条 TCP 隧道')
        } else {
          notify('success', `找到 ${list.length} 条隧道`)
        }
      }
    },
    [notify]
  )

  // 平台切换 / 首次拿到 config 后自动拉取
  useEffect(() => {
    if (!configLoaded) return
    const credential = config?.tunnelTokens?.[providerId] ?? ''
    setToken(credential)
    // 切平台时换成该平台缓存过的列表，避免「切回来是空列表」；
    // 真没有缓存才清空。
    setTunnels(tunnelCache.current[providerId] ?? [])
    setSelectedId(null)
    // 有凭据就自动拉，不用再点「刷新列表」
    if (credential.trim()) {
      void pullTunnels(credential, providerId, true, `${providerId}:${credential.trim()}`)
      void loadAccount(credential, providerId)
    } else {
      setAccount(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [providerId, configLoaded])

  // 轮询运行状态：1.5s 一次，足够跟上手感又不至于太频繁
  useEffect(() => {
    void refreshStatus()
    const timer = setInterval(() => void refreshStatus(), 1500)
    return () => clearInterval(timer)
  }, [refreshStatus])

  const phase: TunnelPhase = status?.phase ?? 'idle'
  const running = status?.running ?? false

  // 状态跃迁时给一次轻提示（只在推进到就绪 / 失败时提示，避免刷屏）
  useEffect(() => {
    const before = prevPhase.current
    prevPhase.current = phase
    if (before === phase) return
    if (phase === 'ready') {
      notify('success', '隧道已就绪', status?.remoteAddr ? `公网地址 ${status.remoteAddr}` : undefined)
    } else if (phase === 'error') {
      // 把 frpc / 服务端的原话带出来，比「请查看日志」有用得多
      notify('error', '隧道启动失败', status?.lastError ?? '请查看右侧 frpc 日志')
    }
  }, [phase, status?.remoteAddr, status?.lastError, notify])

  const meta = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0]

  const openToken = (): void => {
    const saved = token || savedToken
    if (providerId === 'hayfrp') {
      const c = readHayCredential(saved)
      setDraftUser(c.user)
      setDraftPass(c.passwd)
    } else {
      setDraftToken(saved)
    }
    setTokenOpen(true)
  }

  const saveToken = async (): Promise<void> => {
    // HayFrp 要账号密码两个字段，其余平台是一个凭据框
    let value = draftToken.trim()
    if (providerId === 'hayfrp') {
      if (!draftUser.trim() || !draftPass) {
        notify('warn', 'HayFrp 需要同时填写账号和密码')
        return
      }
      value = writeHayCredential(draftUser, draftPass)
    }
    if (!value) {
      notify('warn', '访问凭据不能为空')
      return
    }
    // IPC 侧会先把凭据落盘再去拉隧道，所以即使拉取失败凭据也已保存。
    setLoading(true)
    const list = await invoke(() => window.nova.tunnel.list(providerId, value), '拉取隧道失败')
    setLoading(false)

    // 凭据已经保存到本地了，先把它同步到界面状态并关掉弹窗，
    // 免得用户填完还得再填一次。
    setToken(value)
    setTokenOpen(false)
    // 标记为已自动拉取，避免 effect 再拉一次
    autoPulled.current.add(`${providerId}:${value}`)

    if (!list) {
      // 拉取失败：凭据保留，让用户改完再试
      notify('error', '凭据已保存，但拉取隧道失败', '请检查凭据是否正确，或稍后重试')
      return
    }
    setTunnels(list)
    tunnelCache.current[providerId] = list
    setSelectedId(null)
    void loadAccount(value, providerId)
    notify('success', '凭据已保存', `找到 ${list.length} 条隧道`)
  }

  /** 手动刷新（自动拉取已经覆盖了常规场景，这里给用户一个手动兜底） */
  const refreshTunnels = async (): Promise<void> => {
    if (!token.trim()) {
      notify('warn', '请先配置访问凭据')
      openToken()
      return
    }
    await pullTunnels(token, providerId)
  }

  const start = async (): Promise<void> => {
    const tunnel = tunnels.find((t) => t.id === selectedId)
    if (!tunnel) {
      notify('warn', '请先选择一条隧道')
      return
    }
    setStarting(true)
    const res = await invoke(
      () => window.nova.tunnel.start(providerId, token.trim(), tunnel),
      '启动隧道失败'
    )
    setStarting(false)
    if (res) {
      await refreshStatus()
    }
  }

  const stop = async (): Promise<void> => {
    await invoke(() => window.nova.tunnel.stop(), '停止隧道失败')
    await refreshStatus()
  }

  const selectedTunnel = useMemo(
    () => tunnels.find((t) => t.id === selectedId) ?? null,
    [tunnels, selectedId]
  )

  const remoteAddr = status?.remoteAddr ?? selectedTunnel?.remoteAddr ?? null
  const localPort = status?.localPort ?? selectedTunnel?.localPort ?? 25565

  const current = trackIndex(phase)
  const hasToken = Boolean(token.trim() || savedToken)

  /** 复制公网地址 —— 隧道一就绪就该能让用户直接发给朋友 */
  const copyAddr = async (): Promise<void> => {
    if (!remoteAddr) {
      notify('warn', '还没有可复制的地址', '先把隧道启动起来')
      return
    }
    const ok = await copyText(remoteAddr)
    if (ok) notify('success', '地址已复制', `${remoteAddr} 直接发给朋友就能连`)
    else notify('error', '复制失败', '请手动选中地址右键复制')
  }

  /** 把归一后的账号数据摊成几个统计块 */
  const statItems = useMemo(() => {
    if (!account || account.warn) return []
    const items: { label: string; value: string; low?: boolean }[] = []

    const remain = formatMb(account.trafficRemainingMb)
    if (remain) {
      items.push({
        label: '剩余流量',
        value: remain,
        // 不到 1 GB 变成警示色，提醒该去签到了
        low: (account.trafficRemainingMb ?? 0) < 1024
      })
    }
    const today = formatMb(account.trafficTodayMb)
    if (today) items.push({ label: '今日已用', value: today })

    const up = formatMbps(account.bandwidthInMbps)
    const down = formatMbps(account.bandwidthOutMbps)
    const single = formatMbps(account.bandwidthMbps)
    if (up && down && up === down) items.push({ label: '带宽', value: `${up}` })
    else if (up || down) items.push({ label: '带宽', value: `${up ?? '—'} / ${down ?? '—'}` })
    else if (single) items.push({ label: '带宽', value: single })

    if (account.tunnelsLimit !== undefined) {
      // 樱花不返回已用数量，用拉到的隧道列表长度补上
      const used = account.tunnelsUsed ?? (tunnels.length > 0 ? tunnels.length : undefined)
      items.push({
        label: '隧道',
        value: `${used ?? '—'} / ${account.tunnelsLimit}`
      })
    }
    if (account.group) items.push({ label: '用户组', value: account.group })

    return items
  }, [account, tunnels.length])

  return (
    <>
      <div className="page-head">
        <div>
          <h1>内网穿透</h1>
          <div className="sub">让好友通过公网连进你的世界 · 隧道开启后切换页面不会断开</div>
        </div>
        <span className={`tnl-state-badge ${badgeClass(phase)}`}>
          {phase === 'starting' || phase === 'connecting' || phase === 'stopping' ? (
            <span className="tnl-spinner" style={{ width: 12, height: 12 }} />
          ) : phase === 'ready' ? (
            <span className="tnl-port-light on" />
          ) : null}
          {phaseLabel(phase)}
        </span>
      </div>

      <div className="section" style={{ display: 'flex', gap: 20, alignItems: 'flex-start' }}>
        {/* ------------------------------------------------------ 左列 */}
        <div className="grow col" style={{ gap: 14 }}>
          {/* 平台切换 */}
          <div className="tnl-tabs">
            {PROVIDERS.map((p) => (
              <button
                key={p.id}
                className={`tnl-tab ${providerId === p.id ? 'on' : ''}`}
                onClick={() => setProviderId(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>

          {/* 令牌配置行：主界面只显示状态，配置动作放进弹窗 */}
          <div className="tnl-token-bar">
            <span className={`dot ${hasToken ? '' : 'off'}`} />
            <div className="grow" style={{ minWidth: 0 }}>
              <div style={{ fontSize: 12.5, fontWeight: 600 }}>
                {loading && hasToken ? '正在拉取隧道…' : hasToken ? '访问凭据已配置' : '尚未配置访问凭据'}
              </div>
              <div style={{ fontSize: 10.5, color: 'var(--text-3)', marginTop: 2 }}>
                {hasToken
                  ? `${meta.label} · 凭据仅保存在本机 · 已自动拉取`
                  : `配置后即可自动拉取你在${meta.label}创建的隧道`}
              </div>
            </div>
            <button className="btn sm ghost" onClick={openToken}>
              <Icon name="gear" size={11} />
              配置凭据
            </button>
            {hasToken ? (
              <button className="btn sm ghost" onClick={() => void refreshTunnels()} disabled={loading}>
                {loading ? '拉取中…' : '刷新列表'}
              </button>
            ) : null}
          </div>

          {/* 账号概况：剩余流量 / 带宽 / 隧道数 */}
          {account?.warn ? (
            <div className="tnl-warn">
              <Icon name="warning" size={12} />
              {account.warn}
            </div>
          ) : statItems.length > 0 ? (
            <div className="tnl-stats">
              {statItems.map((s) => (
                <div key={s.label} className={`tnl-stat ${s.low ? 'low' : ''}`}>
                  <div className="tnl-stat-label">{s.label}</div>
                  <div className="tnl-stat-value">{s.value}</div>
                </div>
              ))}
            </div>
          ) : null}

          {/* 隧道列表 */}
          <div className="card" style={{ overflow: 'hidden' }}>
            {tunnels.length === 0 ? (
              <Empty
                title={loading && hasToken ? '正在拉取隧道…' : '还没有隧道'}
                hint={
                  loading && hasToken
                    ? '正在从平台获取你的隧道列表'
                    : hasToken
                      ? '平台上没有找到隧道，去平台创建一条 TCP 隧道后点「刷新列表」'
                      : '先点「配置凭据」填入访问凭据，之后会自动拉取隧道列表'
                }
              />
            ) : (
              tunnels.map((t) => (
                <button
                  key={t.id}
                  className={`tnl-row ${selectedId === t.id ? 'on' : ''}`}
                  onClick={() => setSelectedId(t.id)}
                >
                  <span className={`tnl-port-light ${t.online ? 'on' : 'off'}`} />
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="tnl-row-name">{t.name}</span>
                    <span className="tnl-row-meta">
                      {t.remoteAddr ? (
                        <span className="tnl-row-addr">{t.remoteAddr}</span>
                      ) : (
                        <span>未上线</span>
                      )}
                      {t.localPort ? <span>本地 {t.localPort}</span> : null}
                      {t.type ? <span>{t.type}</span> : null}
                      {t.node ? <span>{t.node}</span> : null}
                    </span>
                  </span>
                  <span className={`badge ${t.online ? 'accent' : ''}`}>{t.online ? '在线' : '离线'}</span>
                  {selectedId === t.id ? (
                    <span
                      className="tnl-port-light on"
                      style={{ background: 'var(--accent)' }}
                    />
                  ) : null}
                </button>
              ))
            )}
          </div>
        </div>

        {/* ------------------------------------------------------ 右列：控制台 */}
        <div
          className="card"
          style={{ width: 348, padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span style={{ fontSize: 12.5, fontWeight: 600 }}>连接控制台</span>
            <span className={`badge ${badgeClass(phase)}`}>{phaseLabel(phase)}</span>
          </div>

          {/* 状态轨道：把阶段画成一条推进中的链路 */}
          <div className="tnl-track">
            {TRACK_STEPS.map((s, i) => {
              const state =
                phase === 'error'
                  ? 'failed'
                  : current < 0
                    ? ''
                    : i < current
                      ? 'done'
                      : i === current
                        ? 'active'
                        : ''
              return (
                <div key={s.phase} className={`tnl-step ${state}`}>
                  <div className="tnl-step-dot">{state === 'done' ? '✓' : i + 1}</div>
                  <div className="tnl-step-label">{s.label}</div>
                </div>
              )
            })}
          </div>

          {/* 阶段说明 */}
          <div
            style={{
              fontSize: 10.5,
              color: phase === 'error' ? 'var(--danger)' : 'var(--text-3)',
              lineHeight: 1.7,
              minHeight: 34
            }}
          >
            {phase === 'idle'
              ? '选择一条隧道后点下方按钮启动。启动过程会实时检测节点握手与本地端口状态。'
              : phase === 'starting'
                ? '正在拉起内置 frpc 进程…'
                : phase === 'connecting'
                  ? 'frpc 已启动，正在与穿透节点握手…'
                  : phase === 'online'
                    ? '隧道已建立，但本地端口还没人监听。启动 Minecraft 并「对局域网开放」后会自动变为就绪。'
                    : phase === 'ready'
                      ? '隧道与游戏端口均已就绪，把上面的公网地址发给好友即可联机。'
                      : phase === 'offline'
                        ? '本地端口掉线了，可能是游戏关闭了。重新启动游戏即可恢复。'
                        : phase === 'stopping'
                          ? '正在关闭 frpc 进程…'
                          : '启动失败，请查看下方 frpc 日志定位原因（常见是令牌失效或隧道 ID 不对）。'}
            {phase === 'error' && status?.lastError ? (
              <div className="mono" style={{ marginTop: 6, color: 'var(--danger)' }}>
                {status.lastError}
              </div>
            ) : null}
          </div>

          {/* 主操作按钮 */}
          {running ? (
            <button className="tnl-launch stop" onClick={() => void stop()}>
              <Icon name="stop" size={13} />
              停止隧道
            </button>
          ) : (
            <button
              className={`tnl-launch ${starting ? 'busy' : ''}`}
              onClick={() => void start()}
              disabled={starting || !selectedId}
            >
              {starting ? (
                <>
                  <span className="tnl-spinner" />
                  正在启动…
                </>
              ) : (
                <>
                  <Icon name="play" size={12} />
                  启动隧道
                </>
              )}
            </button>
          )}

          {/* 隧道通了就把「复制地址」摆在最顺手的位置 */}
          {running && remoteAddr ? (
            <button className="tnl-launch copy" onClick={() => void copyAddr()}>
              <Icon name="copy" size={12} />
              复制地址发给朋友
            </button>
          ) : null}

          {/* 连接信息 */}
          <div className="kv">
            <dt>本地端口</dt>
            <dd style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
              <span className={`tnl-port-light ${status?.portOpen ? 'on' : running ? 'off' : ''}`} />
              <span className="mono">{localPort}</span>
              <span className={`badge ${status?.portOpen ? 'accent' : running ? 'warn' : ''}`}>
                {status?.portOpen
                  ? '在线'
                  : running
                    ? '未监听'
                    : '未启动'}
              </span>
            </dd>
            {status?.latencyMs !== undefined && status.portOpen ? (
              <>
                <dt>探测耗时</dt>
                <dd className="mono">{status.latencyMs} ms</dd>
              </>
            ) : null}
            <dt>进程 PID</dt>
            <dd className="mono">{status?.pid ?? '—'}</dd>
            {remoteAddr ? (
              <>
                <dt>公网地址</dt>
                <dd style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span className="mono" style={{ userSelect: 'text', color: 'var(--accent)' }}>
                    {remoteAddr}
                  </span>
                  <button className="tnl-copy" onClick={() => void copyAddr()}>
                    <Icon name="copy" size={10} />
                    复制
                  </button>
                </dd>
              </>
            ) : null}
          </div>

          {/* 日志 */}
          {status && status.log.length > 0 ? (
            <div
              className="mono"
              style={{
                padding: 10,
                borderRadius: 8,
                background: 'var(--surface-2)',
                fontSize: 9.5,
                color: 'var(--text-3)',
                maxHeight: 170,
                overflow: 'auto',
                lineHeight: 1.65,
                whiteSpace: 'pre-wrap'
              }}
            >
              {status.log.slice(-26).join('\n')}
            </div>
          ) : null}

          <div style={{ fontSize: 9.5, color: 'var(--text-3)', lineHeight: 1.7 }}>
            端口检测会主动连接本机 {localPort} 端口，确认真的有服务在监听。
            联机前请确认 Minecraft 的 server-port 与这里一致，并已「对局域网开放」。
          </div>
        </div>
      </div>

      {/* -------------------------------------------------- 令牌配置弹窗 */}
      {tokenOpen ? (
        <div className="modal-mask" onClick={() => setTokenOpen(false)}>
          <div className="modal-box" onClick={(e) => e.stopPropagation()}>
            <div style={{ padding: '18px 20px 0' }}>
              <div style={{ fontSize: 15, fontWeight: 600 }}>配置访问凭据</div>
              <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 5, lineHeight: 1.7 }}>
                {meta.tokenHint}。
                {providerId === 'hayfrp'
                  ? '账号密码只保存在本机配置里，用于登录换取 7 天有效期的接口凭据。'
                  : '令牌只保存在本机配置里，不会上传到任何服务器。'}
              </div>
            </div>
            <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
              {providerId === 'hayfrp' ? (
                <>
                  <input
                    className="input"
                    autoFocus
                    placeholder="HayFrp 账号或邮箱"
                    value={draftUser}
                    onChange={(e) => setDraftUser(e.target.value)}
                  />
                  <input
                    className="input"
                    type="password"
                    placeholder="HayFrp 密码"
                    value={draftPass}
                    onChange={(e) => setDraftPass(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && void saveToken()}
                  />
                </>
              ) : (
                <input
                  className="input mono"
                  autoFocus
                  placeholder={`粘贴 ${meta.label} 的访问凭据`}
                  value={draftToken}
                  onChange={(e) => setDraftToken(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && void saveToken()}
                />
              )}
              <div style={{ display: 'flex', gap: 8 }}>
                <a
                  href={meta.docUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="btn sm ghost"
                  style={{ textDecoration: 'none' }}
                >
                  打开官方文档
                </a>
                <div className="grow" />
                <button className="btn sm ghost" onClick={() => setTokenOpen(false)}>
                  取消
                </button>
                <button className="btn primary" onClick={() => void saveToken()} disabled={loading}>
                  {loading ? '验证中…' : '保存并拉取'}
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
