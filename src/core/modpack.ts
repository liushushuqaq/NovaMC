import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { DownloadPool } from './download'
import type { VersionService } from './version'
import type { InstanceStore } from './instance'
import type { ForgeService } from './forge'
import type { InstanceConfig, ModpackSummary } from './types'
import { fail, wrap } from './errors'

const API = 'https://api.modrinth.com/v2'

interface SearchHit {
  project_id: string
  slug: string
  title: string
  description: string
  icon_url?: string
  downloads: number
  categories: string[]
  versions: string[]
  project_type: string
}

interface ProjectVersion {
  id: string
  name: string
  version_number: string
  game_versions: string[]
  loaders: string[]
  date_published: string
  files: {
    url: string
    filename: string
    primary: boolean
    size: number
    hashes: { sha1?: string; sha512?: string }
  }[]
  dependencies?: { version_id?: string; project_id?: string; dependency_type: string }[]
}

interface MrpackIndex {
  formatVersion: number
  game: string
  versionId: string
  name: string
  dependencies: Record<string, string>
  files: {
    path: string
    hashes: { sha1?: string; sha512?: string }
    env?: { client?: 'required' | 'optional' | 'unsupported' }
    downloads: string[]
    fileSize?: number
  }[]
}

export interface ModrinthExtras {
  forge?: ForgeService
  /** 拿一个能跑指定 Java 主版本的 java 可执行文件 */
  getJava?: (major: number) => Promise<string>
}

export class ModrinthService {
  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths,
    private readonly versions: VersionService,
    private readonly instances: InstanceStore,
    /** 可选：让整合包也能装 Forge / NeoForge */
    private readonly extras: ModrinthExtras = {}
  ) {}

  async search(query: string, gameVersion?: string): Promise<ModpackSummary[]> {
    const facets: string[][] = [['project_type:modpack']]
    if (gameVersion) facets.push([`versions:${gameVersion}`])
    const url = `${API}/search?query=${encodeURIComponent(query)}&limit=20&facets=${encodeURIComponent(
      JSON.stringify(facets)
    )}`
    const { data } = await this.http.json<{ hits: SearchHit[] }>(url, { timeoutMs: 15_000 })
    return (data.hits ?? []).map((h) => ({
      projectId: h.project_id,
      slug: h.slug,
      title: h.title,
      description: h.description,
      iconUrl: h.icon_url,
      downloads: h.downloads,
      gameVersions: h.versions ?? [],
      loaders: (h.categories ?? []).filter((c) => ['fabric', 'forge', 'neoforge', 'quilt'].includes(c)),
      provider: 'modrinth' as const
    }))
  }

  async install(
    projectId: string,
    instanceName: string | undefined,
    onProgress: (stats: { label: string; done: number; total: number }) => void
  ): Promise<InstanceConfig> {
    // 1) 取该整合包最新版本
    const { data: versions } = await this.http.json<ProjectVersion[]>(`${API}/project/${projectId}/version`, {
      timeoutMs: 15_000
    })
    const target = versions?.[0]
    if (!target) throw fail('E_MODPACK_FORMAT', '该整合包没有可用版本')

    const file = target.files.find((f) => f.primary) ?? target.files[0]
    if (!file) throw fail('E_MODPACK_FORMAT', '整合包缺少下载文件')

    // 2) 下载 .mrpack 到临时目录
    onProgress({ label: '下载整合包', done: 0, total: 1 })
    const tmpDir = path.join(this.paths.root, 'tmp')
    await fs.mkdir(tmpDir, { recursive: true })
    const packFile = path.join(tmpDir, `${crypto.randomUUID()}.mrpack`)
    await this.pool.run(
      [{ url: file.url, dest: packFile, sha1: file.hashes.sha1, size: file.size, label: file.filename }],
      () => {}
    )

    // 3) 读 index
    let index: MrpackIndex
    try {
      const zip = new AdmZip(packFile)
      const entry = zip.getEntry('modrinth.index.json')
      if (!entry) throw new Error('缺少 modrinth.index.json')
      index = JSON.parse(entry.getData().toString('utf8')) as MrpackIndex
    } catch (e) {
      throw wrap('E_MODPACK_FORMAT', e, '无法解析整合包')
    }

    const minecraft = index.dependencies.minecraft
    if (!minecraft) throw fail('E_MODPACK_FORMAT', '整合包未声明游戏版本')

    // 4) 装加载器：Fabric / Forge / NeoForge 都支持自动安装
    const fabricLoader = index.dependencies['fabric-loader']
    const forgeVer = index.dependencies['forge']
    const neoVer = index.dependencies['neoforge']
    const quiltVer = index.dependencies['quilt-loader']

    let versionId: string
    let loader: { kind: 'fabric' | 'forge' | 'neoforge'; version: string }

    if (fabricLoader) {
      onProgress({ label: '安装 Fabric 加载器', done: 0, total: 1 })
      versionId = (await this.versions.installFabric(minecraft, fabricLoader)).versionId
      loader = { kind: 'fabric', version: fabricLoader }
    } else if (forgeVer || neoVer) {
      const family: 'forge' | 'neoforge' = neoVer ? 'neoforge' : 'forge'
      const loaderVer = (neoVer ?? forgeVer) as string
      if (!this.extras.forge || !this.extras.getJava) {
        throw fail('E_MODPACK_LOADER', `无法自动安装 ${family}：组件未初始化`)
      }
      onProgress({ label: `安装 ${family === 'forge' ? 'Forge' : 'NeoForge'} 加载器`, done: 0, total: 1 })
      const javaPath = await this.extras.getJava(17)
      versionId = (
        await this.extras.forge.install(family, loaderVer, {
          javaPath,
          onProgress: (label, done, total) => onProgress({ label, done, total })
        })
      ).versionId
      loader = { kind: family, version: loaderVer }
    } else if (quiltVer) {
      throw fail('E_MODPACK_LOADER', 'Quilt 加载器暂不支持自动安装，请手动安装后导入这个整合包')
    } else {
      throw fail('E_MODPACK_LOADER', '该整合包未声明受支持的模组加载器')
    }

    // 5) 建实例
    const instance = await this.instances.create({
      name: instanceName ?? index.name ?? target.name,
      gameVersion: minecraft,
      versionId,
      loader,
      memory: { minMb: 2048, maxMb: 8192 },
      window: { width: 1280, height: 720, fullscreen: false },
      source: { provider: 'modrinth', projectId, versionId: target.id, title: index.name }
    })

    const gameDir = this.paths.instanceGameDir(instance.slug)

    // 6) 整合包文件
    const files = index.files.filter((f) => (f.env?.client ?? 'required') !== 'unsupported')
    const tasks = files.map((f) => ({
      url: f.downloads[0],
      mirrors: f.downloads.slice(1),
      dest: path.join(gameDir, f.path),
      sha1: f.hashes.sha1,
      size: f.fileSize,
      label: path.basename(f.path)
    }))

    await this.pool.run(tasks, (t) => onProgress({ label: t.current, done: t.doneFiles, total: t.totalFiles }))

    // 7) overrides / client-overrides 覆盖
    try {
      const zip = new AdmZip(packFile)
      await extractPrefix(zip, 'overrides/', gameDir)
      await extractPrefix(zip, 'client-overrides/', gameDir)
    } catch (e) {
      throw wrap('E_EXTRACT_FAILED', e, '覆盖文件解压失败')
    }

    await fs.rm(packFile, { force: true }).catch(() => {})
    onProgress({ label: '完成', done: files.length, total: files.length })
    return instance
  }
}

async function extractPrefix(zip: AdmZip, prefix: string, dest: string): Promise<void> {
  const root = path.resolve(dest)
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue
    const name = entry.entryName.replace(/\\/g, '/')
    if (!name.startsWith(prefix)) continue
    const rel = name.slice(prefix.length)
    if (!rel) continue
    const target = path.resolve(path.join(root, rel))
    if (!target.startsWith(root + path.sep)) continue // 路径穿越
    await fs.mkdir(path.dirname(target), { recursive: true })
    await fs.writeFile(target, entry.getData())
  }
}
