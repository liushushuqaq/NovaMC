import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { DownloadPool } from './download'
import type { PackLoader, PackManifest } from './types'
import { fail, wrap } from './errors'

/**
 * 本地整合包导入。
 *
 * 现在只认三种包：
 *   1. CurseForge 导出（manifest.json + overrides/）—— 国内整合包绝大多数是这个
 *   2. Modrinth 格式（modrinth.index.json）
 *   3. 裸 .minecraft 压缩包（有 mods/ config/ 但没有清单）—— 直接整个解压当游戏目录
 *
 * CurseForge 的坑：manifest 里只有 projectID/fileID，没有文件名，
 * 而 CDN 直链是 `edge.forgecdn.net/files/{id/1000}/{id%1000}/{文件名}` —— 必须要文件名。
 * 官方 API 要 key，所以走公开镜像 mod.mcimirror.top（它的路径就是 CF v1 API 的镜像）。
 */

/** CurseForge API 镜像，国内访问比官方快，且不需要 key */
const CF_API = 'https://mod.mcimirror.top/curseforge/v1'

/** ForgeCDN 的直链主机，第一个不通就换第二个 */
const CF_CDN_HOSTS = ['https://edge.forgecdn.net', 'https://mediafilez.forgecdn.net']

interface CurseManifest {
  name?: string
  version?: string
  author?: string
  minecraft?: {
    version?: string
    recommendedRam?: number
    modLoaders?: { id?: string; primary?: boolean }[]
  }
  files?: { projectID?: number; fileID?: number; required?: boolean }[]
  overrides?: string
}

interface MrpackIndex {
  name?: string
  versionId?: string
  dependencies?: Record<string, string>
  files?: { path?: string; downloads?: string[] }[]
}

export class PackImporter {
  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths
  ) {}

  /** 读压缩包里的清单，不落盘 */
  async peek(zipPath: string): Promise<PackManifest> {
    const zip = readZip(zipPath)

    // 1) CurseForge
    const cfEntry = zip.getEntry('manifest.json')
    if (cfEntry) {
      let m: CurseManifest
      try {
        m = JSON.parse(cfEntry.getData().toString('utf8')) as CurseManifest
      } catch (e) {
        throw wrap('E_MODPACK_FORMAT', e, 'manifest.json 解析失败')
      }
      const loaderId = (m.minecraft?.modLoaders ?? []).find((l) => l.primary)?.id ?? m.minecraft?.modLoaders?.[0]?.id
      const files = (m.files ?? [])
        .filter((f) => f.projectID && f.fileID)
        .map((f) => ({ projectId: Number(f.projectID), fileId: Number(f.fileID) }))

      return {
        format: 'curseforge',
        zipPath,
        name: m.name?.trim() || path.basename(zipPath, path.extname(zipPath)),
        version: m.version,
        minecraft: m.minecraft?.version,
        loader: parseLoaderId(loaderId),
        recommendedRamMb: m.minecraft?.recommendedRam,
        files,
        overridePrefixes: collectPrefixes(zip, [
          `${m.overrides ?? 'overrides'}/`,
          'client-overrides/'
        ]),
        bundledMods: countEntries(zip, [`${m.overrides ?? 'overrides'}/mods/`, 'mods/'])
      }
    }

    // 2) Modrinth
    const mrEntry = zip.getEntry('modrinth.index.json')
    if (mrEntry) {
      let idx: MrpackIndex
      try {
        idx = JSON.parse(mrEntry.getData().toString('utf8')) as MrpackIndex
      } catch (e) {
        throw wrap('E_MODPACK_FORMAT', e, 'modrinth.index.json 解析失败')
      }
      const deps = idx.dependencies ?? {}
      const loaderKind = ['fabric', 'forge', 'neoforge'].find((k) => deps[`${k}-loader`]) as
        | 'fabric'
        | 'forge'
        | 'neoforge'
        | undefined
      const loaderVersion = loaderKind ? deps[`${loaderKind}-loader`] : undefined

      return {
        format: 'modrinth',
        zipPath,
        name: idx.name?.trim() || path.basename(zipPath, path.extname(zipPath)),
        version: idx.versionId,
        minecraft: deps.minecraft,
        loader: loaderKind && loaderVersion ? { kind: loaderKind, version: loaderVersion } : undefined,
        files: [],
        overridePrefixes: collectPrefixes(zip, ['overrides/', 'client-overrides/']),
        bundledMods: countEntries(zip, ['overrides/mods/', 'client-overrides/mods/'])
      }
    }

    // 3) 裸目录包
    return {
      format: 'raw',
      zipPath,
      name: path.basename(zipPath, path.extname(zipPath)),
      files: [],
      overridePrefixes: [''],
      bundledMods: countEntries(zip, ['mods/'])
    }
  }

  /**
   * 把所有模组下载到 <gameDir>/mods。
   *
   * 分两步：先解析（projectID/fileID → 文件名 + 大小），再下载。
   * 解析走镜像，单条约 150ms，并发 6 条，400 个模组十几秒能过完。
   */
  async downloadMods(
    manifest: PackManifest,
    gameDir: string,
    onProgress: (s: { label: string; done: number; total: number }) => void,
    shouldAbort?: () => boolean
  ): Promise<{ ok: number; failed: { id: number; reason: string }[] }> {
    if (manifest.files.length === 0) return { ok: 0, failed: [] }

    const modsDir = path.join(gameDir, 'mods')
    await fs.mkdir(modsDir, { recursive: true })

    // --- 1. 解析 ---
    const total = manifest.files.length
    let resolvedCount = 0
    const failed: { id: number; reason: string }[] = []

    const resolved = await mapLimit(manifest.files, 6, async (f) => {
      if (shouldAbort?.()) return null
      const info = await this.resolveCurseFile(f.projectId, f.fileId).catch(() => null)
      resolvedCount += 1
      if (resolvedCount % 5 === 0 || resolvedCount === total) {
        onProgress({ label: `解析模组 ${resolvedCount}/${total}`, done: resolvedCount, total })
      }
      if (!info) {
        failed.push({ id: f.fileId, reason: '镜像查不到这个文件' })
        return null
      }
      return info
    })

    if (shouldAbort?.()) throw fail('E_IMPORT_CANCELLED', '导入已取消')

    const ready = resolved.filter((x): x is ResolvedFile => x !== null)
    if (ready.length === 0) {
      throw fail('E_MODPACK_FORMAT', '这个整合包的模组全部解析失败，请检查网络或换一个镜像')
    }

    // --- 2. 下载 ---
    const tasks = ready.map((f) => ({
      url: f.url,
      mirrors: f.mirrors,
      dest: path.join(modsDir, f.fileName),
      size: f.size,
      label: f.fileName
    }))

    const res = await this.pool.run(
      tasks,
      (t) =>
        onProgress({
          label: t.current || '下载模组',
          done: t.doneFiles,
          total: t.totalFiles
        }),
      // 几百个模组里挂几个不该让整个导入前功尽弃，最后统一报告
      {
        tolerateFailures: true,
        maxFailures: Math.max(20, Math.ceil(tasks.length * 0.05)),
        shouldAbort
      }
    )

    if (shouldAbort?.()) throw fail('E_IMPORT_CANCELLED', '导入已取消')

    for (const item of res.failedItems) {
      failed.push({ id: 0, reason: `${item.label}：${item.error}` })
    }

    return { ok: res.total - res.failed, failed }
  }

  /** 把 overrides / client-overrides 铺到游戏目录（合并，不删除已有文件） */
  async extractOverrides(
    manifest: PackManifest,
    gameDir: string,
    onProgress?: (s: { label: string; done: number; total: number }) => void,
    shouldAbort?: () => boolean
  ): Promise<void> {
    const prefixes = manifest.overridePrefixes.filter((p) => p !== '')
    if (prefixes.length === 0) {
      // 裸目录包：整个包就是游戏目录
      await this.extractAll(manifest.zipPath, gameDir, onProgress, shouldAbort)
      return
    }
    const zip = readZip(manifest.zipPath)
    const total = zip
      .getEntries()
      .filter((e) => !e.isDirectory && prefixes.some((p) => e.entryName.startsWith(p))).length
    let done = 0
    for (const prefix of prefixes) {
      await extractPrefix(
        zip,
        prefix,
        gameDir,
        () => {
          done++
          if (done % 20 === 0 || done === total) {
            onProgress?.({ label: '展开配置与资源', done, total })
          }
        },
        shouldAbort
      )
    }
    onProgress?.({ label: '展开配置与资源', done: total, total })
  }

  private async extractAll(
    zipPath: string,
    dest: string,
    onProgress?: (s: { label: string; done: number; total: number }) => void,
    shouldAbort?: () => boolean
  ): Promise<void> {
    const zip = readZip(zipPath)
    const total = zip.getEntries().filter((e) => !e.isDirectory).length
    let done = 0
    await extractPrefix(zip, '', dest, () => {
      done++
      if (done % 20 === 0 || done === total) onProgress?.({ label: '展开整合包', done, total })
    }, shouldAbort)
  }

  /** 单个文件的元信息：文件名、大小、CDN 直链 */
  private async resolveCurseFile(projectId: number, fileId: number): Promise<ResolvedFile> {
    const { data } = await this.http.jsonWithError<{ data?: { fileName?: string; fileLength?: number } }>(
      `${CF_API}/mods/${projectId}/files/${fileId}`,
      { timeoutMs: 15_000 }
    )
    const fileName = data?.data?.fileName
    if (!fileName) throw fail('E_MODPACK_FORMAT', `文件 ${fileId} 没有文件名`)
    return {
      fileName,
      size: data.data?.fileLength,
      url: cdnUrl(CF_CDN_HOSTS[0], fileId, fileName),
      mirrors: CF_CDN_HOSTS.slice(1).map((h) => cdnUrl(h, fileId, fileName))
    }
  }
}

interface ResolvedFile {
  fileName: string
  size?: number
  url: string
  mirrors: string[]
}

/** ForgeCDN 的文件路径规则：files/{id/1000}/{id%1000}/{文件名} */
function cdnUrl(host: string, fileId: number, fileName: string): string {
  return `${host}/files/${Math.floor(fileId / 1000)}/${fileId % 1000}/${encodeURIComponent(fileName)}`
}

/** "fabric-0.18.4" → { kind:'fabric', version:'0.18.4' } */
function parseLoaderId(id: string | undefined): PackLoader | undefined {
  if (!id) return undefined
  const m = id.match(/^(fabric|forge|neoforge|quilt)-(.+)$/i)
  if (!m) return undefined
  const kind = m[1].toLowerCase()
  if (kind === 'quilt') return undefined
  return { kind: kind as PackLoader['kind'], version: m[2] }
}

function readZip(zipPath: string): AdmZip {
  try {
    return new AdmZip(zipPath)
  } catch (e) {
    throw wrap('E_MODPACK_FORMAT', e, '打不开这个压缩包，可能不是 zip 或已损坏')
  }
}

/** 只保留包里真实存在的目录前缀 */
function collectPrefixes(zip: AdmZip, candidates: string[]): string[] {
  const names = new Set(zip.getEntries().map((e) => e.entryName))
  return candidates.filter((prefix) =>
    [...names].some((n) => n.startsWith(prefix) && n.length > prefix.length)
  )
}

/** 统计某个目录下有多少个 .jar */
function countEntries(zip: AdmZip, prefixes: string[]): number {
  return zip
    .getEntries()
    .filter((e) => prefixes.some((p) => e.entryName.startsWith(p)) && e.entryName.endsWith('.jar')).length
}

async function extractPrefix(
  zip: AdmZip,
  prefix: string,
  dest: string,
  onFile?: () => void,
  shouldAbort?: () => boolean
): Promise<void> {
  const root = path.resolve(dest)
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    if (prefix && !entry.entryName.startsWith(prefix)) continue
    if (shouldAbort?.()) throw fail('E_IMPORT_CANCELLED', '导入已取消')
    const rel = prefix ? entry.entryName.slice(prefix.length) : entry.entryName
    if (!rel) continue
    const out = path.resolve(root, rel)
    // 防 zip-slip：解出来的路径必须还在目标目录里
    if (out !== root && !out.startsWith(root + path.sep)) continue
    await fs.mkdir(path.dirname(out), { recursive: true })
    await fs.writeFile(out, entry.getData())
    onFile?.()
  }
}

/** 并发受限的 map */
async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      out[i] = await fn(items[i])
    }
  })
  await Promise.all(workers)
  return out
}
