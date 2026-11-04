/**
 * 在线更新：从 GitHub Releases 拉取新版本信息并下载。
 *
 * 更新源是公开仓库的 Releases，检测走 GitHub API（匿名可访问），
 * 下载走 releases/download 的静态资源直链。全程零 token、零额外依赖。
 */
import { HttpClient } from './http'
import { wrap } from './errors'
import crypto from 'node:crypto'
import fs from 'node:fs'

export interface UpdateInfo {
  version: string
  tagName: string
  name: string
  notes: string
  publishedAt: string
  url: string
  size: number
  sha256?: string
}

export interface UpdateCheckResult {
  /** 有没有比当前更新的版本 */
  hasUpdate: boolean
  currentVersion: string
  latest: UpdateInfo | null
}

const API_BASE = 'https://api.github.com/repos/liushushuqaq/NovaMC-Updates'

function semverGt(a: string, b: string): boolean {
  const pa = a.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const pb = b.split('.').map((n) => Number.parseInt(n, 10) || 0)
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i++) {
    const x = pa[i] ?? 0
    const y = pb[i] ?? 0
    if (x > y) return true
    if (x < y) return false
  }
  return false
}

/**
 * 从 Release 正文里解析 `sha256: xxx`（可选）。发布脚本会在备注里写这一行，
 * 客户端据此做完整性校验；没写就跳过校验。
 */
function parseSha256(body: string): string | undefined {
  const m = /sha256[:\s]+([a-f0-9]{64})/i.exec(body ?? '')
  return m?.[1]?.toLowerCase()
}

export class Updater {
  constructor(private http: HttpClient) {}

  /** 拉取最新 Release 并与当前版本比较 */
  async check(currentVersion: string): Promise<UpdateCheckResult> {
    let rel: GitHubRelease | null = null
    try {
      const { data } = await this.http.json<GitHubRelease>(`${API_BASE}/releases/latest`)
      rel = data
    } catch (e) {
      // 仓库还没有任何 Release 时 GitHub 返回 404，这不算错误，就是「暂无新版本」
      if (e instanceof Error && /HTTP 404/.test(e.message)) rel = null
      else throw e
    }
    const latest = rel ? normalizeRelease(rel) : null
    return {
      hasUpdate: latest != null && semverGt(latest.version, currentVersion),
      currentVersion,
      latest
    }
  }

  /** 流式下载新 exe 到指定路径，返回字节数；写完做 SHA256 校验 */
  async download(info: UpdateInfo, destPath: string, onProgress?: (done: number, total: number) => void): Promise<number> {
    const res = await this.http.raw(info.url, { timeoutMs: 0 })
    if (!res.ok) throw wrap('E_HTTP', new Error(`HTTP ${res.status}`), '下载更新失败')
    if (!res.body) throw wrap('E_NETWORK', new Error('no body'), '下载更新失败')

    const total = info.size || Number(res.headers.get('content-length')) || 0
    const tmp = `${destPath}.tmp`
    const hash = crypto.createHash('sha256')
    let done = 0

    await new Promise<void>((resolve, reject) => {
      const reader = (res.body as ReadableStream<Uint8Array>).getReader()
      const out = fs.createWriteStream(tmp)
      const pump = async (): Promise<void> => {
        try {
          for (;;) {
            const { done: finished, value } = await reader.read()
            if (finished) break
            done += value.byteLength
            hash.update(value)
            if (!out.write(Buffer.from(value))) {
              await new Promise<void>((r) => out.once('drain', r))
            }
            onProgress?.(done, total)
          }
          out.end()
          out.on('finish', () => resolve())
          out.on('error', reject)
        } catch (e) {
          reject(e)
        }
      }
      void pump()
    })

    // 校验
    if (info.sha256) {
      const actual = hash.digest('hex')
      if (actual !== info.sha256) {
        try {
          fs.rmSync(tmp, { force: true })
        } catch {
          /* ignore */
        }
        throw wrap('E_INTEGRITY', new Error('sha256 mismatch'), '下载文件校验失败，可能被篡改或下载不完整')
      }
    }

    fs.renameSync(tmp, destPath)
    return done
  }
}

interface GitHubRelease {
  tag_name: string
  name?: string
  body?: string
  published_at?: string
  assets?: Array<{ name: string; browser_download_url: string; size: number }>
}

function normalizeRelease(rel: GitHubRelease): UpdateInfo | null {
  if (!rel?.tag_name) return null
  const version = rel.tag_name.replace(/^v/, '')
  const exe = rel.assets?.find((a) => /\.exe$/i.test(a.name))
  if (!exe) return null
  return {
    version,
    tagName: rel.tag_name,
    name: rel.name || rel.tag_name,
    notes: rel.body || '',
    publishedAt: rel.published_at || '',
    url: exe.browser_download_url,
    size: exe.size,
    sha256: parseSha256(rel.body || '')
  }
}
