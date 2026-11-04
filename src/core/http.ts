import { wrap } from './errors'

export interface RequestOptions {
  timeoutMs?: number
  headers?: Record<string, string>
  method?: string
  body?: string | Uint8Array
}

/**
 * 全局 fetch 的薄封装：统一 UA、超时、状态码处理。
 * 重试策略放在 DownloadPool 里，因为只有它知道"文件级"失败意味着什么。
 */
export class HttpClient {
  constructor(private readonly userAgent = 'NovaMC/0.1.0 (launcher; +https://novamc.dev)') {}

  async raw(url: string, opts: RequestOptions = {}): Promise<Response> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 20_000)
    try {
      const res = await fetch(url, {
        method: opts.method ?? 'GET',
        headers: { 'User-Agent': this.userAgent, ...(opts.headers ?? {}) },
        body: opts.body as RequestInit['body'],
        signal: controller.signal,
        redirect: 'follow'
      })
      return res
    } catch (e) {
      throw wrap('E_NETWORK', e, `请求失败 ${shorten(url)}`)
    } finally {
      clearTimeout(timeout)
    }
  }

  async json<T>(url: string, opts: RequestOptions = {}): Promise<{ status: number; data: T; etag?: string }> {
    const res = await this.raw(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } })
    if (res.status === 304) return { status: 304, data: undefined as unknown as T, etag: res.headers.get('etag') ?? undefined }
    if (!res.ok) throw wrap('E_HTTP', new Error(`HTTP ${res.status}`), `请求失败 ${shorten(url)}`)
    const data = (await res.json()) as T
    return { status: res.status, data, etag: res.headers.get('etag') ?? undefined }
  }

  /**
   * 请求并在失败时把服务端返回的错误消息带出来。
   *
   * 樱花、幻缘的鉴权失败都是「HTTP 500 + { code: 401, msg: '访问密钥无效' }」
   * 这种形式——只报「请求失败 api.natfrp.com/v4/tunnels」等于什么都没说，
   * 用户根本不知道是密钥填错了还是网络问题。
   */
  async jsonWithError<T>(url: string, opts: RequestOptions = {}): Promise<{ status: number; data: T }> {
    const res = await this.raw(url, { ...opts, headers: { Accept: 'application/json', ...(opts.headers ?? {}) } })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = text ? JSON.parse(text) : undefined
    } catch {
      parsed = undefined
    }
    if (!res.ok) {
      const msg = extractApiError(parsed) ?? extractApiError(text)
      throw wrap(
        'E_HTTP',
        new Error(`HTTP ${res.status}`),
        msg ? `${msg}（${shorten(url)}）` : `请求失败 ${shorten(url)}`
      )
    }
    return { status: res.status, data: parsed as T }
  }

  async text(url: string, opts: RequestOptions = {}): Promise<string> {
    const res = await this.raw(url, opts)
    if (!res.ok) throw wrap('E_HTTP', new Error(`HTTP ${res.status}`), `请求失败 ${shorten(url)}`)
    return res.text()
  }

  async stream(url: string, opts: RequestOptions = {}): Promise<ReadableStream<Uint8Array>> {
    const res = await this.raw(url, opts)
    if (!res.ok || !res.body) throw wrap('E_HTTP', new Error(`HTTP ${res.status}`), `下载失败 ${shorten(url)}`)
    return res.body
  }
}

function shorten(url: string): string {
  try {
    const u = new URL(url)
    // 只留最后一段会把「请求失败 1.21.1」这种废话甩给用户，带上网址才看得出卡在哪
    const full = `${u.host}${u.pathname}`
    return full.length > 64 ? `${full.slice(0, 61)}…` : full
  } catch {
    return url.length > 64 ? `${url.slice(0, 61)}…` : url
  }
}

/**
 * 从 API 错误响应里挖出人类可读的消息。
 *
 * 樱花 / 幻缘的格式：
 *   { code: 401, msg: '访问密钥无效' }
 *   { code: 403, message: '无权访问' }
 *   { code: 401, data: { msg: '...' } }
 */
function extractApiError(body: unknown): string | null {
  if (typeof body === 'string') {
    const m = body.match(/"(?:msg|message|error)"\s*:\s*"([^"]+)"/)
    return m ? m[1] : null
  }
  if (!body || typeof body !== 'object') return null
  const o = body as Record<string, unknown>
  for (const key of ['msg', 'message', 'error', 'detail']) {
    const v = o[key]
    if (typeof v === 'string' && v.trim()) return v.trim()
  }
  // 嵌套一层
  for (const key of ['data', 'result', 'error']) {
    const v = o[key]
    if (v && typeof v === 'object') {
      const nested = extractApiError(v)
      if (nested) return nested
    }
  }
  return null
}
