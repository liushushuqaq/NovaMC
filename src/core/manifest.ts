import fs from 'node:fs/promises'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { MirrorConfig } from './mirror'
import { manifestUrl } from './mirror'
import type { VersionManifest, VersionSummary } from './types'
import { fail, wrap } from './errors'

const TTL = 6 * 60 * 60 * 1000

export type VersionTab = 'all' | 'release' | 'snapshot' | 'legacy'

export class ManifestService {
  private inflight: Promise<VersionManifest> | null = null

  constructor(
    private readonly http: HttpClient,
    private readonly paths: GamePaths,
    private readonly mirror: MirrorConfig
  ) {}

  private get cacheFile(): string {
    return `${this.paths.meta}/version_manifest_v2.json`
  }
  private get etagFile(): string {
    return `${this.paths.meta}/version_manifest_v2.etag`
  }

  async load(force = false): Promise<VersionManifest> {
    if (this.inflight) return this.inflight
    this.inflight = this.doLoad(force).finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private async doLoad(force: boolean): Promise<VersionManifest> {
    const cached = await this.readCache()
    if (!force && cached && Date.now() - cached.mtime < TTL) return cached.data

    const etag = cached ? await this.readEtag() : undefined
    const { primary, mirrors } = manifestUrl(this.mirror.mode)
    const candidates = [primary, ...mirrors]

    for (const url of candidates) {
      try {
        const res = await fetch(url, {
          headers: {
            'User-Agent': 'NovaMC/0.1.0',
            ...(etag ? { 'If-None-Match': etag } : {})
          },
          signal: AbortSignal.timeout(15_000)
        })
        if (res.status === 304 && cached) return cached.data
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = (await res.json()) as VersionManifest
        await fs.mkdir(this.paths.meta, { recursive: true })
        await fs.writeFile(this.cacheFile, JSON.stringify(data))
        const nextEtag = res.headers.get('etag')
        if (nextEtag) await fs.writeFile(this.etagFile, nextEtag)
        return data
      } catch {
        // 换下一个源
      }
    }

    // 全部源失败：只要有旧缓存就继续用，只有从未成功过才报错
    if (cached) return cached.data
    throw wrap('E_MANIFEST_UNAVAILABLE', new Error('所有源均不可用'), '无法获取 Minecraft 版本清单')
  }

  static filter(list: VersionSummary[], tab: VersionTab): VersionSummary[] {
    switch (tab) {
      case 'release':
        return list.filter((v) => v.type === 'release')
      case 'snapshot':
        return list.filter((v) => v.type === 'snapshot')
      case 'legacy':
        return list.filter((v) => v.type === 'old_beta' || v.type === 'old_alpha')
      default:
        return list
    }
  }

  async find(id: string): Promise<VersionSummary> {
    const manifest = await this.load()
    const hit = manifest.versions.find((v) => v.id === id)
    if (!hit) throw fail('E_VERSION_NOT_FOUND', `找不到版本 ${id}`)
    return hit
  }

  private async readCache(): Promise<{ data: VersionManifest; mtime: number } | null> {
    try {
      const [raw, st] = await Promise.all([fs.readFile(this.cacheFile, 'utf8'), fs.stat(this.cacheFile)])
      return { data: JSON.parse(raw) as VersionManifest, mtime: st.mtimeMs }
    } catch {
      return null
    }
  }

  private async readEtag(): Promise<string | undefined> {
    try {
      return (await fs.readFile(this.etagFile, 'utf8')).trim()
    } catch {
      return undefined
    }
  }
}
