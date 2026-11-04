import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import type { HttpClient } from './http'
import { FrpcProcess, resolveFrpcExecutable, type FrpcKind } from './frpc'
import { fail } from './errors'
import { detectPhaseFromLog, resolvePhase, type TunnelPhase } from './tunnelState'
import { probeLocalPort, type PortProbeResult } from './portProbe'
import { toFrpcToml } from './frpcConfig'
import type { TunnelAccountInfo, TunnelProviderId, TunnelSummary, TunnelStatus } from './types'

/**
 * 内网穿透统一抽象。三个平台（樱花 SakuraFrp / 幻缘 ME Frp / HayFrp）都归一到：
 *   填访问凭据 → listTunnels 拉隧道列表 → start 拉起内置 frpc → 监控本地端口。
 *
 * 三家的启动协议不同，对应不同的内置 frpc 与启动方式：
 *   - 樱花：API 用「访问密钥」，启动走 POST /tunnel/config 拿配置 + 官方 frpc `-c`。
 *   - 幻缘：API 用 Bearer Token，启动走 GetProxyConfig 拿标准 TOML + 官方 frpc `-c`。
 *   - HayFrp：API 用账号换 CSRF，启动走 /esirun.php 拿隧道参数自行拼 TOML + 官方 frpc `-c`。
 *
 * 状态：进程存活 + 日志解析 + 端口探测三者综合出 TunnelPhase，
 * 渲染层据此驱动状态变换动画（详见 tunnelState.ts）。
 */

/** provider 返回给进程管理器的启动指令 */
export interface FrpcLaunch {
  /** 用哪份内置 frpc */
  kind: FrpcKind
  /** 传给 frpc 的参数（不含可执行文件本身） */
  args: string[]
}

/**
 * 把鉴权相关的错误翻译成人话。
 *
 * 樱花对无效密钥返回 HTTP 500 + { code: 401, msg: '访问密钥无效' }，
 * 光看状态码分不清是「密钥错了」还是「服务挂了」，这里明确区分。
 */
function wrapAuthError(e: unknown, platform: string): Error {
  const message = e instanceof Error ? e.message : String(e)
  if (/访问密钥无效|访问令牌无效|unauthorized|401|403|无权访问|invalid/i.test(message)) {
    return fail(
      'E_TUNNEL_AUTH',
      `${platform}访问凭据无效，请重新填写（樱花用「访问密钥」，幻缘用「API 令牌」，HayFrp 用账号密码）`
    )
  }
  return e instanceof Error ? e : new Error(message)
}

/**
 * 从 frpc 日志里挑一行最能说明问题的错误。
 *
 * frpc 的日志形如：
 *   2026-11-04 19:40:58.888 [I] [server/root.go:490] [mcia] start error: 无效请求，请检查后重试.
 * 时间戳和源码位置对用户没意义，剥掉只留后半句，UI 的失败提示直接用它。
 */
function pickErrorLine(log: string[]): string | undefined {
  const cleaned = [...log]
    .reverse()
    .map((l) =>
      l
        .replace(/^\d{4}-\d{2}-\d{2}[\sT]\d{2}:\d{2}:\d{2}[.\d]*\s*/, '')
        .replace(/^\[[A-Z]\]\s*(\[\S+\]\s*)?/, '')
        .trim()
    )
    .filter(Boolean)
  const hit = cleaned.find((l) =>
    /error|failed|failure|失败|无效|未知|拒绝|超时|timeout|token/i.test(l)
  )
  return hit && hit.length > 4 ? hit : undefined
}

/* ---------------------------------------------------------------- provider */

export interface TunnelProvider {
  readonly id: TunnelProviderId
  readonly label: string
  /** 用访问令牌换取隧道列表 */
  listTunnels(token: string): Promise<TunnelSummary[]>
  /** 账号概况：剩余流量 / 带宽 / 隧道数 */
  accountInfo(token: string): Promise<TunnelAccountInfo>
  /** 生成拉起 frpc 的启动指令 */
  buildLaunch(token: string, tunnelId: string): Promise<FrpcLaunch>
}

/* ------------------------------------------------------------ 单位换算 */

const BYTES_PER_MB = 1024 * 1024

/** 字节 → MB（三家有两家给字节，一家给 MB，统一到 MB 再展示） */
function bytesToMb(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n / BYTES_PER_MB : undefined
}

/** Kbps → Mbps（幻缘的 inBound/outBound 是 Kbps） */
function kbpsToMbps(v: unknown): number | undefined {
  const n = Number(v)
  return Number.isFinite(n) && n >= 0 ? n / 1000 : undefined
}

/** 樱花把限速直接写成字符串，如 "10 Mbps" / "36 Mbps" */
function parseSpeedText(text: string | undefined): number | undefined {
  if (!text) return undefined
  const m = text.match(/([\d.]+)\s*(Mbps|Mibps|Gbps|Kbps)?/i)
  if (!m) return undefined
  const num = Number(m[1])
  if (!Number.isFinite(num)) return undefined
  const unit = (m[2] ?? 'Mbps').toLowerCase()
  if (unit === 'gbps') return num * 1000
  if (unit === 'kbps') return num / 1000
  return num
}

/* ------------------------------------------------------------------ 樱花 */

export class SakuraProvider implements TunnelProvider {
  readonly id = 'sakura' as const
  readonly label = '樱花内网穿透'
  private readonly api = 'https://api.natfrp.com/v4'

  constructor(private readonly http: HttpClient) {}

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  /**
   * 列出隧道。
   *
   * 樱花 OpenAPI v4 的 `GET /tunnels` **直接返回顶层数组**（不是 `{data: [...]}`），
   * 字段名以官方 schemas/Tunnel.yaml 为准：
   *   id / name / type / node / status / online / local_ip / local_port / remote
   *
   * 注意 `remote` 才是公网地址（我最初误写成 remote_address），
   * `online` 是独立布尔字段（不能靠 remote 是否存在来判断）。
   */
  async listTunnels(token: string): Promise<TunnelSummary[]> {
    if (!token.trim()) {
      throw fail('E_TUNNEL_AUTH', '请先填写访问凭据')
    }
    try {
      const res = await this.http.jsonWithError<SakuraListResponse>(`${this.api}/tunnels`, {
        headers: this.headers(token)
      })
      // 兼容两种形态：顶层数组，或某些网关包了一层 { data: [...] }
      const list = Array.isArray(res.data) ? res.data : (res.data?.data ?? [])

      // 公网地址需要「节点 host + 隧道 remote(端口)」拼出来，
      // 所以顺带拉一次节点列表建立 id → host 映射（拿不到就不拼，不影响主流程）。
      const hostByNode = await this.fetchNodeHosts(token)

      return list.map((t) => {
        const host = hostByNode.get(Number(t.node))
        const remote = t.remote ?? ''
        // remote 可能是「端口号」也可能是「已绑定的域名」
        const remoteAddr = remote
          ? /^\d+$/.test(remote) && host
            ? `${host}:${remote}`
            : remote
          : undefined
        return {
          id: String(t.id),
          name: t.name,
          online: Boolean(t.online),
          remoteAddr,
          localPort: typeof t.local_port === 'number' ? t.local_port : undefined,
          type: t.type ? t.type.toUpperCase() : undefined,
          node: host ?? (t.node !== undefined ? `节点 ${t.node}` : undefined)
        }
      })
    } catch (e) {
      throw wrapAuthError(e, '樱花')
    }
  }

  /** 拉节点列表，建立 节点ID → 节点域名 的映射 */
  private async fetchNodeHosts(token: string): Promise<Map<number, string>> {
    const map = new Map<number, string>()
    try {
      const res = await this.http.jsonWithError<Record<string, SakuraNode>>(`${this.api}/nodes`, {
        headers: this.headers(token)
      })
      for (const [id, node] of Object.entries(res.data ?? {})) {
        if (node?.host) map.set(Number(id), node.host)
      }
    } catch {
      // 节点信息拉不到不影响隧道列表本身，静默忽略
    }
    return map
  }

  /**
   * 账号概况。
   *
   * `GET /user/info` 的字段口径：
   *   - speed    限速字符串，如 "10 Mbps"
   *   - tunnels  隧道数上限
   *   - traffic  `[本日消耗, 总剩余]`，单位字节
   * 账号被冻结时返回的是另一个分支（带 ban 对象），转成 warn 提示即可。
   */
  async accountInfo(token: string): Promise<TunnelAccountInfo> {
    try {
      const res = await this.http.jsonWithError<SakuraUserInfo | SakuraBanned>(
        `${this.api}/user/info`,
        { headers: this.headers(token) }
      )
      const u = res.data
      if (!u) throw fail('E_TUNNEL_AUTH', '樱花没有返回账号信息')
      if ('ban' in u && u.ban) {
        return { provider: 'sakura', warn: u.ban.title || u.ban.reason || '账号已被冻结' }
      }
      const info = u as SakuraUserInfo
      const [todayBytes, remainBytes] = info.traffic ?? []
      return {
        provider: 'sakura',
        group: info.group?.name,
        trafficRemainingMb: bytesToMb(remainBytes),
        trafficTodayMb: bytesToMb(todayBytes),
        bandwidthMbps: parseSpeedText(info.speed),
        tunnelsLimit: info.tunnels
      }
    } catch (e) {
      throw wrapAuthError(e, '樱花')
    }
  }

  /**
   * 生成启动指令。
   *
   * 官方 spec 里**没有 `/frpc` 这个路径**（我最初调错了，404）。
   * 正确做法是 `POST /tunnel/config`：传隧道 ID 与目标 frpc 版本，
   * 服务端直接返回**可被 frpc 加载的配置文件**。
   *
   * 这样樱花与幻缘统一走 `-c config.toml`，只需内置一份官方 frpc，
   * 也不依赖樱花的定制版客户端。
   */
  async buildLaunch(token: string, tunnelId: string): Promise<FrpcLaunch> {
    // 这个接口返回的是纯文本（text/plain 或 text/toml），不是 JSON
    const res = await this.http.text(`${this.api}/tunnel/config`, {
      method: 'POST',
      headers: { ...this.headers(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: tunnelId, frpc: SAKURA_FRPC_VERSION })
    })

    const config = res.trim()
    if (!config) {
      throw fail('E_TUNNEL_AUTH', '无法获取樱花的隧道配置，请确认访问密钥是否有效')
    }
    // 服务端可能返回 ini 或 toml（取决于请求的 frpc 版本），
    // 内置的官方 frpc 主要吃 toml，统一转一道。
    const toml = toFrpcToml(config)

    const tmpDir = path.join(os.tmpdir(), 'novamc-frpc')
    await fs.mkdir(tmpDir, { recursive: true })
    const configPath = path.join(tmpDir, `sakura-${crypto.randomUUID()}.toml`)
    await fs.writeFile(configPath, toml, 'utf8')

    return { kind: 'vanilla', args: ['-c', configPath] }
  }
}

/**
 * 请求配置时指定的 frpc 版本。
 *
 * 官方 spec 写明支持「上游 frpc 版本如 0.59.0，最低 0.18.0」，
 * 指定上游版本服务端会返回标准 TOML，内置的官方 frpc v0.71 直接可用。
 * 若指定樱花自己的版本号（0.51.0-sakura-*），返回的是 INI 格式。
 */
const SAKURA_FRPC_VERSION = '0.59.0'

/**
 * 樱花隧道列表响应。
 * 顶层是数组；部分网关可能包一层 data，字段兼容两种。
 */
type SakuraListResponse = SakuraTunnel[] | { data?: SakuraTunnel[] }

interface SakuraTunnel {
  id: number
  name: string
  type?: string
  node?: number
  status?: number
  online?: boolean
  local_ip?: string
  local_port?: number
  remote?: string
}

/** 节点信息（GET /nodes 返回的对象，key 是节点 ID） */
interface SakuraNode {
  name?: string
  host?: string
  description?: string
  vip?: number
  flag?: number
}

/** GET /user/info —— 正常账号 */
interface SakuraUserInfo {
  name?: string
  /** 限速信息字符串，如 "10 Mbps" */
  speed?: string
  /** 隧道数上限 */
  tunnels?: number
  group?: { name?: string; level?: number; expires?: number }
  /** [本日消耗, 总剩余]，单位字节 */
  traffic?: number[]
}

/** GET /user/info —— 冻结账号走这个分支 */
interface SakuraBanned {
  ban?: { title?: string; reason?: string; expires?: number }
}

/* ------------------------------------------------------------------ 幻缘 */

export class MefrpProvider implements TunnelProvider {
  readonly id = 'mefrp' as const
  readonly label = '幻缘内网穿透'
  private readonly api = 'https://api.mefrp.com/api'

  constructor(private readonly http: HttpClient) {}

  private headers(token: string): Record<string, string> {
    return { Authorization: `Bearer ${token}` }
  }

  async listTunnels(token: string): Promise<TunnelSummary[]> {
    if (!token.trim()) {
      throw fail('E_TUNNEL_AUTH', '请先填写访问凭据')
    }
    try {
      // ME Frp OpenAPI：GET /auth/proxy/list，返回 { code, data: { nodes, proxies } }
      const res = await this.http.jsonWithError<MefrpListResponse>(`${this.api}/auth/proxy/list`, {
        headers: this.headers(token)
      })
      if (res.data.code !== 200) {
        throw fail('E_TUNNEL_AUTH', `幻缘返回错误码 ${res.data.code}，请确认访问凭据是否有效`)
      }
      const proxies = res.data.data?.proxies ?? []
      const nodes = res.data.data?.nodes ?? []
      const hostnameByNode = new Map(nodes.map((n) => [Number(n.nodeId), n.hostname]))

      return proxies.map((p) => {
        const nodeId = typeof p.nodeId === 'number' ? p.nodeId : Number(p.nodeId)
        const host = hostnameByNode.get(nodeId)
        const domain = firstDomain(p.domain) ?? host
        const remotePort = p.remotePort
        const remoteAddr = domain && typeof remotePort === 'number' ? `${domain}:${remotePort}` : domain

        return {
          id: String(p.proxyId),
          name: p.proxyName || `隧道 ${p.proxyId}`,
          online: Boolean(p.isOnline),
          remoteAddr: remoteAddr || undefined,
          localPort: typeof p.localPort === 'number' ? p.localPort : undefined,
          type: p.proxyType,
          node: host || (nodeId ? `节点 ${nodeId}` : undefined)
        }
      })
    } catch (e) {
      throw wrapAuthError(e, '幻缘')
    }
  }

  /**
   * 账号概况。
   *
   * `GET /auth/user/info` 的字段口径：
   *   - traffic     剩余流量，MiB
   *   - inBound / outBound  入站 / 出站带宽，Kbps
   *   - maxProxies / usedProxies  隧道数上限 / 已用
   *   - status  0 正常、1 封禁、2 流量超限
   */
  async accountInfo(token: string): Promise<TunnelAccountInfo> {
    try {
      const res = await this.http.jsonWithError<MefrpUserInfoResponse>(
        `${this.api}/auth/user/info`,
        { headers: this.headers(token) }
      )
      const d = res.data?.data
      if (res.data?.code !== 200 || !d) {
        throw fail('E_TUNNEL_AUTH', `幻缘返回错误码 ${res.data?.code}，请确认访问凭据是否有效`)
      }
      const status = Number(d.status)
      const remaining = Number(d.traffic)
      return {
        provider: 'mefrp',
        group: d.friendlyGroup || d.group,
        trafficRemainingMb: Number.isFinite(remaining) ? remaining : undefined,
        bandwidthInMbps: kbpsToMbps(d.inBound),
        bandwidthOutMbps: kbpsToMbps(d.outBound),
        tunnelsUsed: d.usedProxies,
        tunnelsLimit: d.maxProxies,
        warn: status === 1 ? '账号已被封禁' : status === 2 ? '流量已超限，隧道会被断开' : undefined
      }
    } catch (e) {
      throw wrapAuthError(e, '幻缘')
    }
  }

  async buildLaunch(token: string, tunnelId: string): Promise<FrpcLaunch> {
    // 拿标准 TOML 配置，用官方 frpc -c 启动（幻缘服务端兼容上游 frpc）
    const res = await this.http.json<{ code: number; data?: { config?: string } }>(
      `${this.api}/auth/proxy/config`,
      {
        method: 'POST',
        headers: { ...this.headers(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ proxyId: Number(tunnelId), format: 'toml' })
      }
    )
    const config = res.data?.data?.config
    if (!config) {
      throw fail('E_TUNNEL_AUTH', '无法获取幻缘的隧道配置，请确认访问令牌与隧道 ID 是否有效')
    }

    // 写临时 toml，frpc -c 读取
    const tmpDir = path.join(os.tmpdir(), 'novamc-frpc')
    await fs.mkdir(tmpDir, { recursive: true })
    const configPath = path.join(tmpDir, `${crypto.randomUUID()}.toml`)
    await fs.writeFile(configPath, toFrpcToml(config), 'utf8')

    return { kind: 'vanilla', args: ['-c', configPath] }
  }
}

interface MefrpNode {
  nodeId: string | number
  name?: string
  hostname?: string
}

interface MefrpProxy {
  proxyId: number
  proxyName?: string
  proxyType?: string
  localPort?: number
  remotePort?: number
  nodeId?: number
  isOnline?: boolean
  domain?: string
}

interface MefrpListResponse {
  code: number
  data?: { nodes: MefrpNode[]; proxies: MefrpProxy[] }
}

/** GET /auth/user/info 的 data */
interface MefrpUserInfo {
  userId?: number
  username?: string
  group?: string
  friendlyGroup?: string
  isRealname?: boolean
  /** 入站带宽，Kbps */
  inBound?: number
  /** 出站带宽，Kbps */
  outBound?: number
  /** 剩余流量，MiB */
  traffic?: number
  maxProxies?: number
  usedProxies?: number
  /** 0 正常 / 1 封禁 / 2 流量超限 */
  status?: number
}

interface MefrpUserInfoResponse {
  code: number
  data?: MefrpUserInfo
  message?: string
}

/** domain 是文本化列表，如 '["xx.mefrp.com"]'，取第一个可用域名 */
function firstDomain(domain: string | undefined): string | undefined {
  if (!domain) return undefined
  try {
    const arr = JSON.parse(domain) as unknown
    if (Array.isArray(arr) && arr.length) return String(arr[0])
  } catch {
    /* 不是 JSON，就当纯字符串 */
  }
  const cleaned = domain.replace(/[\[\]"'\s]/g, '')
  return cleaned || undefined
}

/* ---------------------------------------------------------------- HayFrp */

/**
 * HayFrp 的三个 API 入口，按顺位做故障转移。
 * 官方前端就是这么干的：网络错误或 5xx 时换下一个，最多三次。
 */
const HAY_BASES = [
  'https://api.hayfrp.1zyq1.com',
  'https://v2.api.hayfrp.1zyq1.com',
  'https://api.hayfrp.com'
]

/** HayFrp 的凭证：账号密码，或用户自己贴的登录 CSRF */
interface HayCredential {
  user: string
  passwd: string
  /** 用户直接贴的 CSRF（没有账号密码时才用） */
  csrf?: string
}

/**
 * HayFrp（文档：https://docs.hayfrp.com/）
 *
 * 与另外两家最大的差别：**它没有可以直接复制的 API Token**。
 * 开放接口全部用「登录 CSRF」鉴权，而 CSRF 只能拿账号密码去换（有效期 7 天）。
 * 所以这里的凭据是「账号 + 密码」，落盘存成 {"user","passwd"} 的 JSON；
 * 同时也兼容直接粘 CSRF 的用法（从浏览器 localStorage.csrf 里取）。
 *
 * 启动链路（官方「简单启动」协议）：
 *   登录 → /esirun.php type=get|create 换隧道级密钥 → /esirun.php type=config
 *   → 拿到 serverAddr / serverPort / auth.token 与隧道参数 → 自己拼 TOML → frpc -c
 * 这样不必内置 HayFrp 那套定制 frpc（它的 `-esirun` 参数官方 frpc 没有）。
 */
export class HayfrpProvider implements TunnelProvider {
  readonly id = 'hayfrp' as const
  readonly label = 'HayFrp'

  /** 登录 CSRF 缓存：一次 listTunnels + 一次 start 不必登录两遍 */
  private cached: { key: string; csrf: string; at: number } | null = null

  constructor(private readonly http: HttpClient) {}

  /** 解析落盘的凭据：JSON → 账号密码；含冒号 → 账号:密码；否则当 CSRF */
  private static parse(raw: string): HayCredential {
    const text = raw.trim()
    if (!text) throw fail('E_TUNNEL_AUTH', '请先填写 HayFrp 的账号和密码')
    if (text.startsWith('{')) {
      try {
        const o = JSON.parse(text) as { user?: string; passwd?: string; csrf?: string }
        if (o.csrf && !o.user) return { user: '', passwd: '', csrf: o.csrf }
        if (o.user && o.passwd) return { user: o.user, passwd: o.passwd }
      } catch {
        /* 落到下面的兜底 */
      }
    }
    const i = text.indexOf(':')
    if (i > 0) {
      const user = text.slice(0, i).trim()
      const passwd = text.slice(i + 1)
      if (user && passwd) return { user, passwd }
    }
    return { user: '', passwd: '', csrf: text }
  }

  /**
   * 调用 HayFrp 的 POST 接口。
   *
   * 两个与其他平台不同、必须处理的地方：
   *   1. 所有请求都要带 `waf: off`，否则被雷池 WAF 拦掉；
   *   2. 业务错误用 **HTTP 200 + { status: 403 }** 表达，靠 HTTP 状态码判断成败会全错。
   * 另外它偶尔会在 JSON 前面吐 PHP Warning，所以解析时从第一个 `{` 开始截。
   */
  private async post<T extends HayResponse>(path: string, body: Record<string, unknown>): Promise<T> {
    let last: unknown = null
    for (const base of HAY_BASES) {
      try {
        const res = await this.http.raw(`${base}${path}`, {
          method: 'POST',
          timeoutMs: 15_000,
          headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json;charset=UTF-8',
            waf: 'off'
          },
          body: JSON.stringify(body)
        })
        const text = await res.text()
        // 5xx 视作该节点故障，换下一个
        if (res.status >= 500) {
          last = fail('E_HTTP', `HayFrp ${base} 返回 HTTP ${res.status}`)
          continue
        }
        const parsed = looseJson(text)
        if (!parsed) {
          last = fail('E_HTTP', `HayFrp 返回了无法解析的内容（HTTP ${res.status}）`)
          continue
        }
        return parsed as T
      } catch (e) {
        last = e
      }
    }
    throw last instanceof Error ? last : fail('E_NETWORK', 'HayFrp 接口全部不可用，请检查网络')
  }

  /** 成功判定：status 可能是 200、true 或 "200" */
  private static ok(res: HayResponse): boolean {
    return res.status === 200 || res.status === true || res.status === '200'
  }

  /** 取登录 CSRF（命中缓存则复用） */
  private async csrfOf(cred: HayCredential): Promise<string> {
    if (cred.csrf) return cred.csrf

    const key = `${cred.user}\u0000${cred.passwd}`
    if (this.cached && this.cached.key === key && Date.now() - this.cached.at < 6 * 24 * 3600_000) {
      return this.cached.csrf
    }

    const res = await this.post<HayResponse & { token?: string | null }>('/user', {
      type: 'login',
      user: cred.user,
      passwd: cred.passwd,
      // 保留已有 CSRF，避免把用户其他设备挤下线
      keepcsrf: true
    })
    if (!HayfrpProvider.ok(res) || !res.token) {
      // 服务端文案本身已经很具体（"用户还没有注册."/"您的密码有误"），
      // 加个平台前缀即可，别再套一层「登录失败」重复一遍。
      const msg = (res.message || '').trim().replace(/[.。]$/, '')
      throw fail('E_TUNNEL_AUTH', msg ? `HayFrp：${msg}` : 'HayFrp 登录失败，请检查账号或密码')
    }
    this.cached = { key, csrf: res.token, at: Date.now() }
    return res.token
  }

  async listTunnels(token: string): Promise<TunnelSummary[]> {
    const cred = HayfrpProvider.parse(token)
    try {
      const csrf = await this.csrfOf(cred)
      const res = await this.post<HayResponse & { proxies?: HayProxy[] }>('/proxy', {
        type: 'list',
        csrf
      })
      if (!HayfrpProvider.ok(res)) {
        throw fail('E_TUNNEL_AUTH', `HayFrp 返回：${res.message || '凭据无效或已过期'}`)
      }
      const proxies = res.proxies ?? []

      // list 里的 status 只表示「隧道是否启用」，真实在线状态要另外 check。
      // 隧道数量通常个位数，并发查一次不慢；查不到就按离线算，不阻塞列表。
      const online = await Promise.all(
        proxies.map((p) => this.checkOnline(csrf, String(p.id)).catch(() => false))
      )

      return proxies.map((p, i) => {
        const type = (p.proxy_type || '').toLowerCase()
        const remote = p.remote_port ? String(p.remote_port) : ''
        const domain = firstDomain(p.domain)
        const nodeDomain = p.node_domain || ''
        // TCP/UDP 的公网地址是「节点域名 + 远程端口」，HTTP(S) 直接是绑定域名
        const remoteAddr =
          type === 'tcp' || type === 'udp'
            ? nodeDomain && remote
              ? `${nodeDomain}:${remote}`
              : remote || undefined
            : domain || (nodeDomain && remote ? `${nodeDomain}:${remote}` : undefined)

        return {
          id: String(p.id),
          name: p.proxy_name || `隧道 ${p.id}`,
          online: online[i],
          remoteAddr,
          localPort: p.local_port ? Number(p.local_port) || undefined : undefined,
          type: type ? type.toUpperCase() : undefined,
          node: p.node_name || (p.node ? `节点 ${p.node}` : undefined)
        }
      })
    } catch (e) {
      throw wrapAuthError(e, 'HayFrp')
    }
  }

  /**
   * 账号概况。
   *
   * `POST /user {type:info}` 的字段全是字符串：
   *   - traffic       剩余流量，MB
   *   - todaytraffic  今日流量，字节
   *   - proxies / useproxies  隧道数上限 / 已用
   */
  async accountInfo(token: string): Promise<TunnelAccountInfo> {
    const cred = HayfrpProvider.parse(token)
    const csrf = await this.csrfOf(cred)
    const res = await this.post<HayUserInfo>('/user', { type: 'info', csrf })
    if (!HayfrpProvider.ok(res)) {
      throw fail('E_TUNNEL_AUTH', `HayFrp：${res.message || '读取账号信息失败'}`)
    }
    const num = (v: unknown): number | undefined => {
      const n = Number(v)
      return Number.isFinite(n) ? n : undefined
    }
    return {
      provider: 'hayfrp',
      group: res.group,
      trafficRemainingMb: num(res.traffic),
      trafficTodayMb: bytesToMb(res.todaytraffic),
      tunnelsUsed: num(res.useproxies),
      tunnelsLimit: num(res.proxies)
    }
  }

  /** 单条隧道的实时在线状态（status 500 + "隧道离线." 属于正常返回，不是错误） */
  private async checkOnline(csrf: string, id: string): Promise<boolean> {
    const res = await this.post<HayResponse & { ostatus?: string }>('/proxy', {
      type: 'check',
      csrf,
      id
    })
    return res.ostatus === 'online' || res.status === 200
  }

  async buildLaunch(token: string, tunnelId: string): Promise<FrpcLaunch> {
    const cred = HayfrpProvider.parse(token)
    const csrf = await this.csrfOf(cred)

    // 1. 换隧道级启动密钥：优先 get（不覆盖已有密钥），没有再用 create 生成
    let tunnelKey = ''
    const got = await this.post<HayResponse & { csrf?: string }>('/esirun.php', {
      type: 'get',
      id: tunnelId,
      csrf
    })
    if (HayfrpProvider.ok(got) && got.csrf) {
      tunnelKey = got.csrf
    } else {
      const created = await this.post<HayResponse & { csrf?: string }>('/esirun.php', {
        type: 'create',
        id: tunnelId,
        csrf
      })
      if (!HayfrpProvider.ok(created) || !created.csrf) {
        throw fail(
          'E_TUNNEL_AUTH',
          `HayFrp 无法生成启动密钥：${created.message || '隧道不可用或不属于当前账号'}`
        )
      }
      tunnelKey = created.csrf
    }

    // 2. 用隧道密钥拉完整参数（这一步不需要登录态）
    const cfg = await this.post<HayResponse & { data?: HayEasyConfig }>('/esirun.php', {
      type: 'config',
      csrf: tunnelKey
    })
    const data = cfg.data
    if (!HayfrpProvider.ok(cfg) || !data) {
      throw fail('E_TUNNEL_AUTH', `HayFrp 拉取隧道配置失败：${cfg.message || '密钥无效或已过期'}`)
    }

    // 3. 拼 TOML 写临时文件，交给内置官方 frpc
    const toml = buildHayToml(data, tunnelId)
    const tmpDir = path.join(os.tmpdir(), 'novamc-frpc')
    await fs.mkdir(tmpDir, { recursive: true })
    const configPath = path.join(tmpDir, `hayfrp-${crypto.randomUUID()}.toml`)
    await fs.writeFile(configPath, toml, 'utf8')

    return { kind: 'vanilla', args: ['-c', configPath] }
  }
}

interface HayResponse {
  status?: number | boolean | string
  message?: string
}

/** POST /user {type:info} —— 字段几乎都是字符串 */
interface HayUserInfo extends HayResponse {
  username?: string
  group?: string
  /** 剩余流量，MB */
  traffic?: string
  /** 今日流量，字节 */
  todaytraffic?: string
  /** 隧道数上限 */
  proxies?: string
  /** 已用隧道数 */
  useproxies?: string
}

interface HayProxy {
  id: string | number
  proxy_name?: string
  proxy_type?: string
  local_ip?: string
  local_port?: string | number
  remote_port?: string | number
  domain?: string
  sk?: string
  status?: string
  node?: string
  node_name?: string
  node_domain?: string
}

/** /esirun.php type=config 返回的 data */
interface HayEasyConfig {
  id?: string
  proxy_name?: string
  proxy_type?: string
  local_ip?: string
  local_port?: string | number
  remote_port?: string | number
  domain?: string
  sk?: string
  use_encryption?: string
  use_compression?: string
  hostname?: string
  ip?: string
  port?: string | number
  /** 节点 frps 的授权密钥（frpc 的 auth.token） */
  key?: string
  /** 用户级 token，HayFrp 的 frps 要求放在 frpc 的 `user` 字段里 */
  token?: string
}

/**
 * 把 HayFrp 的隧道参数拼成 frpc v1 的 TOML。
 * 字段对照见 https://docs.hayfrp.com/api/easyrun 的「客户端一键启动流程」。
 */
export function buildHayToml(d: HayEasyConfig, tunnelId: string): string {
  const type = (d.proxy_type || 'tcp').toLowerCase()
  const host = d.hostname || d.ip || ''
  if (!host) {
    throw fail('E_TUNNEL_CONFIG', 'HayFrp 没有返回节点地址，无法生成 frpc 配置')
  }

  const lines = [
    `serverAddr = ${tomlStr(host)}`,
    `serverPort = ${Number(d.port) || 7000}`
  ]
  // HayFrp 的 frps 是魔改版：它把 frp 的 `user` 字段拿来做「用户 token」，
  // 登录时拿不到 user 就报「未知用户名」，拿错了就报「用户 Token 不存在」。
  // 注意这里放的是 token（tunnel 配置里的 `token` 字段），不是用户名。
  if (d.token) lines.push(`user = ${tomlStr(d.token)}`)
  if (d.key) lines.push(`auth.token = ${tomlStr(d.key)}`)

  lines.push('', '[[proxies]]')
  lines.push(`name = ${tomlStr(d.proxy_name || `novamc-${tunnelId}`)}`)
  lines.push(`type = ${tomlStr(type)}`)
  lines.push(`localIP = ${tomlStr(d.local_ip || '127.0.0.1')}`)
  lines.push(`localPort = ${Number(d.local_port) || 25565}`)

  if (type === 'tcp' || type === 'udp' || type === 'xtcp') {
    const rp = Number(d.remote_port)
    if (rp) lines.push(`remotePort = ${rp}`)
  }
  if (type === 'http' || type === 'https') {
    const domains = parseDomainList(d.domain)
    if (domains.length) lines.push(`customDomains = [${domains.map(tomlStr).join(', ')}]`)
  }
  if ((type === 'xtcp' || type === 'stcp') && d.sk) {
    lines.push(`secretKey = ${tomlStr(d.sk)}`)
  }
  if (String(d.use_encryption) === 'true') lines.push('transport.useEncryption = true')
  if (String(d.use_compression) === 'true') lines.push('transport.useCompression = true')

  return lines.join('\n') + '\n'
}

/** TOML 基本字符串：JSON 的转义规则在这里刚好通用 */
function tomlStr(v: string): string {
  return JSON.stringify(v)
}

/** 域名可能是 'a.com' 也可能是一串，取出所有可用值 */
function parseDomainList(domain: string | undefined): string[] {
  if (!domain) return []
  const text = domain.trim()
  if (!text) return []
  if (text.startsWith('[')) {
    try {
      const arr = JSON.parse(text) as unknown
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean)
    } catch {
      /* 不是合法 JSON 就按分隔符拆 */
    }
  }
  return text
    .split(/[,;，；\s]+/)
    .map((s) => s.replace(/[\[\]"']/g, '').trim())
    .filter(Boolean)
}

/** 从可能夹带 PHP Warning 的响应里取出 JSON 对象 */
function looseJson(text: string): unknown {
  const t = text.trim()
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    /* 继续找第一个 { */
  }
  const start = t.indexOf('{')
  const end = t.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(t.slice(start, end + 1))
  } catch {
    return null
  }
}

/* ---------------------------------------------------------------- 门面 */

export interface TunnelLaunchResult {
  provider: TunnelProviderId
  tunnelId: string
  pid: number
}

export class TunnelService {
  private providers: Record<TunnelProviderId, TunnelProvider>
  private process = new FrpcProcess()
  /** 当前隧道的本地端口 */
  private currentLocalPort: number | null = null
  /** 从日志解析出的最新阶段 */
  private logPhase: TunnelPhase | null = null
  /** 是否已经判定过失败 */
  private hadError = false
  /** 正在停止 */
  private stopping = false
  /** 最近一次端口探测结果 */
  private lastProbe: PortProbeResult | null = null
  /** 当前运行的隧道摘要（用于把公网地址带给 UI） */
  private currentTunnel: TunnelSummary | null = null
  /** 正在进行的端口探测（避免并发堆积） */
  private probing = false
  /** frpc 进程是否已退出（用于区分「还在启动」与「已经挂了」） */
  private processExited = false

  constructor(http: HttpClient) {
    this.providers = {
      sakura: new SakuraProvider(http),
      mefrp: new MefrpProvider(http),
      hayfrp: new HayfrpProvider(http)
    }
  }

  async listTunnels(id: TunnelProviderId, token: string): Promise<TunnelSummary[]> {
    return this.providers[id].listTunnels(token)
  }

  async accountInfo(id: TunnelProviderId, token: string): Promise<TunnelAccountInfo> {
    return this.providers[id].accountInfo(token)
  }

  async start(id: TunnelProviderId, token: string, tunnel: TunnelSummary): Promise<TunnelLaunchResult> {
    if (this.process.running) {
      throw fail('E_TUNNEL_RUNNING', '已有一条隧道在运行，请先停止再切换')
    }
    const provider = this.providers[id]
    const launch = await provider.buildLaunch(token, tunnel.id)
    const executable = resolveFrpcExecutable(launch.kind)

    // 重置状态机
    this.logPhase = 'starting'
    this.hadError = false
    this.stopping = false
    this.lastProbe = null
    this.processExited = false

    const pid = this.process.start({
      executable,
      args: launch.args,
      onLog: (line) => {
        // 日志是状态推进的主要信号源
        const detected = detectPhaseFromLog(line)
        if (detected) {
          this.logPhase = detected
          if (detected === 'error') this.hadError = true
        }
      },
      onExit: () => {
        // 进程自行退出：如果之前判定过成功，说明是运行中掉线；
        // 如果从未成功过（例如下面紧跟一行 [401] 访问密钥无效 就退出），
        // 必须判定为失败，否则 UI 会永远停在「启动中」。
        if (this.logPhase === 'online' || this.logPhase === 'ready') {
          this.hadError = true
        } else if (!this.hadError) {
          this.hadError = true
        }
        this.logPhase = null
        this.processExited = true
      }
    })
    this.currentLocalPort = tunnel.localPort ?? 25565
    this.currentTunnel = tunnel
    return { provider: id, tunnelId: tunnel.id, pid }
  }

  stop(): void {
    this.stopping = true
    this.process.stop()
    this.currentLocalPort = null
    this.currentTunnel = null
    this.lastProbe = null
    this.logPhase = null
  }

  /**
   * 读取隧道状态。
   *
   * 每次调用都会做一次本地端口探测，这样 UI 的状态变换动画
   * 能真实反映「游戏有没有开」，而不是只反映 frpc 进程死活。
   */
  async status(): Promise<TunnelStatus> {
    const running = this.process.running
    let probe: PortProbeResult | null = this.lastProbe

    // 只在隧道进程活着时探测端口；探测并发时复用上一次结果
    if (running && this.currentLocalPort && !this.probing) {
      this.probing = true
      try {
        probe = await probeLocalPort(this.currentLocalPort)
        this.lastProbe = probe
      } catch {
        probe = this.lastProbe
      } finally {
        this.probing = false
      }
    }

    const phase = resolvePhase({
      running,
      logPhase: this.logPhase,
      probe,
      hadError: this.hadError,
      stopping: this.stopping,
      exited: this.processExited
    })

    // 停止动作完成后复位
    if (this.stopping && !running) {
      this.stopping = false
      this.hadError = false
    }

    const log = this.process.tail(40)

    return {
      running,
      pid: this.process.pid,
      phase,
      portOpen: probe?.state === 'online',
      localPort: this.currentLocalPort ?? undefined,
      remoteAddr: this.currentTunnel?.remoteAddr,
      latencyMs: probe?.latencyMs,
      lastError: phase === 'error' ? pickErrorLine(log) : undefined,
      log
    }
  }

  get running(): boolean {
    return this.process.running
  }

  killNow(): void {
    this.process.killNow()
  }
}
