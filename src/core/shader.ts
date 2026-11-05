import fs from 'node:fs/promises'
import path from 'node:path'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { DownloadPool, DownloadTask } from './download'
import type { InstanceConfig, ShaderInstallResult } from './types'
import { fail } from './errors'

const MODRINTH = 'https://api.modrinth.com/v2'

/**
 * 光影支持自动安装。
 *
 * 用户要装光影，光有 shaderpacks 目录不够，还得有一个「光影模组」：
 *   - Fabric / NeoForge → Iris（+ Sodium 优化，Fabric 还需要 Fabric API）
 *   - Forge / 原版     → OptiFine
 *
 * 这里按实例加载器映射出一组要装的模组，从 Modrinth 递归解析 required 依赖
 * （Iris → Sodium → Fabric API），一次性下载到 mods 目录。
 *
 * OptiFine 单独处理：官网无 API，下载页需解析且时通时断，尽力而为，
 * 失败时明确提示用户手动安装（并说清 OptiFine 是「下载后作为 Forge 模组
 * 放进 mods 目录」这个正确姿势）。
 */

/** 一个待安装的模组 */
export interface ShaderPackage {
  slug: string
  title: string
  fileName: string
  downloadUrl: string
  size: number
  sha1?: string
}

interface ModrinthVersion {
  id: string
  name: string
  version_number: string
  version_type: string
  date_published: string
  game_versions: string[]
  loaders: string[]
  files: { url: string; filename: string; primary: boolean; size: number; hashes: { sha1?: string } }[]
  dependencies?: { project_id?: string; dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded' }[]
}

interface ModrinthProject {
  id: string
  slug: string
  title: string
}

/** 每个加载器要装什么（依赖放前面，BFS 顺序即安装顺序） */
const PLAN: Record<string, string[]> = {
  // Fabric：Iris 依赖 Sodium，Sodium 依赖 Fabric API
  fabric: ['fabric-api', 'sodium', 'iris'],
  // NeoForge：Iris 依赖 Sodium
  neoforge: ['sodium', 'iris'],
  // Forge：OptiFine 的 jar 直接放进 mods 就能被 Forge 加载
  forge: ['optifine']
  // 原版（vanilla）不放进来：原版不加载 mods 目录，OptiFine 得装成独立版本，
  // 只丢个 jar 进去等于什么都没做，不能假装支持
}

/** 加载器名 → Modrinth loader 字段 */
const LOADER_KEY: Record<string, string> = {
  fabric: 'fabric',
  neoforge: 'neoforge',
  forge: 'forge',
  quilt: 'quilt'
}

export class ShaderService {
  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths
  ) {}

  supports(instance: InstanceConfig): boolean {
    return Boolean(PLAN[instance.loader.kind])
  }

  planFor(instance: InstanceConfig): string[] {
    return PLAN[instance.loader.kind] ?? []
  }

  /** mods 目录里有没有能开光影的模组（Iris / OptiFine） */
  async status(instance: InstanceConfig): Promise<{ ready: boolean; found: string[] }> {
    const modsDir = path.join(this.paths.instanceGameDir(instance.slug), 'mods')
    const names = await fs.readdir(modsDir).catch(() => [] as string[])
    const found = names.filter((n) => n.endsWith('.jar') && (/iris/i.test(n) || /optifine/i.test(n)))
    return { ready: found.length > 0, found }
  }

  /**
   * 从本地 jar 安装（OptiFine 官网经常连不上时的兜底）。
   * 用户自己下载好 jar 后选文件，这里复制进 mods 目录并完成校验。
   */
  async installLocal(instance: InstanceConfig, jarPath: string): Promise<{ fileName: string }> {
    if (!/\.jar$/i.test(jarPath)) throw fail('E_SHADER_BAD_JAR', '请选择 .jar 文件')
    let stat
    try {
      stat = await fs.stat(jarPath)
    } catch {
      throw fail('E_SHADER_BAD_JAR', '文件不存在或无法读取')
    }
    if (!stat.isFile() || stat.size < 1024) {
      throw fail('E_SHADER_BAD_JAR', '这个 jar 看起来不完整（小于 1KB）')
    }

    const name = path.basename(jarPath)
    if (!/iris|optifine|sodium|shader/i.test(name)) {
      // 不硬性拒绝，但提醒用户可能选错了文件
      // 真正的校验在 status() 里体现（装完还是没识别到）
    }

    const gameDir = this.paths.instanceGameDir(instance.slug)
    await fs.mkdir(gameDir, { recursive: true })
    await fs.mkdir(path.join(gameDir, 'shaderpacks'), { recursive: true })
    const modsDir = path.join(gameDir, 'mods')
    await fs.mkdir(modsDir, { recursive: true })

    const dest = path.join(modsDir, await this.uniqueName(modsDir, name))
    await fs.copyFile(jarPath, dest)
    return { fileName: path.basename(dest) }
  }

  /**
   * 安装光影支持到实例的 mods 目录。
   * BFS 递归解析 required 依赖链，全部下载。
   */
  async install(
    instance: InstanceConfig,
    onProgress?: (label: string, done: number, total: number) => void
  ): Promise<ShaderInstallResult> {
    const slugs = PLAN[instance.loader.kind]
    if (!slugs?.length) {
      throw fail(
        'E_SHADER_UNSUPPORTED',
        instance.loader.kind === 'vanilla'
          ? '原版客户端不会加载 mods 目录，光影装不上。先用 Fabric 或 Forge 实例再开光影'
          : '该加载器暂不支持自动安装光影'
      )
    }

    const gameDir = this.paths.instanceGameDir(instance.slug)
    const modsDir = path.join(gameDir, 'mods')
    await fs.mkdir(modsDir, { recursive: true })
    // 光影包要放 shaderpacks；这个目录不提前建好，用户点「打开光影文件夹」只会看到"路径不存在"
    await fs.mkdir(path.join(gameDir, 'shaderpacks'), { recursive: true })
    await fs.mkdir(path.join(gameDir, 'resourcepacks'), { recursive: true })

    const loader = LOADER_KEY[instance.loader.kind]
    const installed: string[] = []
    const failed: { slug: string; message: string }[] = []
    const seen = new Set<string>()
    const queue: string[] = [...slugs]
    const resolved: ShaderPackage[] = []

    while (queue.length) {
      const slug = queue.shift()!
      if (seen.has(slug)) continue
      seen.add(slug)

      if (slug === 'optifine') {
        const pkg = await this.resolveOptifine(instance.gameVersion)
        if (pkg) resolved.push(pkg)
        else failed.push({ slug, message: 'OptiFine 官网不可达，请手动下载后放进 mods 目录' })
        continue
      }

      const pkg = await this.resolveModrinth(slug, instance.gameVersion, loader).catch(() => undefined)
      if (!pkg) {
        failed.push({ slug, message: 'Modrinth 上没有匹配当前版本与加载器的版本' })
        continue
      }
      resolved.push(pkg)

      // 把 required 依赖的 project_id 转成 slug 继续排队
      const deps = pkg.deps ?? []
      if (deps.length) {
        const depIds = deps.filter((d) => d.dependency_type === 'required').map((d) => d.project_id).filter(Boolean) as string[]
        const idToSlug = await this.slugMap(depIds)
        for (const id of depIds) {
          const depSlug = idToSlug.get(id)
          if (depSlug && !seen.has(depSlug)) queue.push(depSlug)
        }
      }
    }

    // 下载所有已解析的包
    const tasks: DownloadTask[] = []
    for (const p of resolved) {
      tasks.push({
        url: p.downloadUrl,
        dest: path.join(modsDir, await this.uniqueName(modsDir, p.fileName)),
        sha1: p.sha1,
        size: p.size,
        label: p.fileName
      })
    }

    if (tasks.length) {
      onProgress?.('下载光影支持', 0, tasks.length)
      const res = await this.pool.run(
        tasks,
        (s) => onProgress?.(`下载 ${s.current}`, s.doneFiles, s.totalFiles),
        { tolerateFailures: true, maxFailures: tasks.length }
      )
      const failedLabels = new Set(res.failedItems.map((f) => f.label))
      tasks.forEach((task, i) => {
        const pkg = resolved[i]
        if (failedLabels.has(task.label)) {
          const reason = res.failedItems.find((f) => f.label === task.label)?.error ?? '下载失败'
          failed.push({ slug: pkg.slug, message: reason })
        } else {
          installed.push(pkg.slug)
        }
      })
      onProgress?.('完成', tasks.length, tasks.length)
    }

    // 光看下载结果不够：同名文件已存在时会被跳过，这里直接看 mods 目录里有没有光影模组
    const { ready } = await this.status(instance)

    return { installed, failed, ready }
  }

  /** 从 Modrinth 解析一个模组的版本（含 required 依赖的 project_id） */
  private async resolveModrinth(
    slug: string,
    gameVersion: string,
    loader: string | undefined
  ): Promise<(ShaderPackage & { deps: ModrinthVersion['dependencies'] }) | undefined> {
    const loaders = loader ? [loader] : []
    const url =
      `${MODRINTH}/project/${encodeURIComponent(slug)}/version` +
      `?game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}` +
      (loaders.length ? `&loaders=${encodeURIComponent(JSON.stringify(loaders))}` : '')
    const versions = await this.getJson<ModrinthVersion[]>(url)
    if (!versions?.length) return undefined

    const stable = versions.filter((v) => v.version_type === 'release')
    const chosen = (stable.length ? stable : versions).sort(
      (a, b) => Date.parse(b.date_published) - Date.parse(a.date_published)
    )[0]
    if (!chosen) return undefined

    const file = chosen.files.find((f) => f.primary) ?? chosen.files[0]
    if (!file) return undefined

    const projects = await this.getJson<ModrinthProject[]>(
      `${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify([slug]))}`
    ).catch(() => undefined)

    return {
      slug,
      title: projects?.[0]?.title ?? chosen.name,
      fileName: file.filename,
      downloadUrl: file.url,
      size: file.size,
      sha1: file.hashes.sha1,
      deps: chosen.dependencies
    }
  }

  /** 批量把 project_id 转成 slug（Modrinth 的 dependencies 只给 id） */
  private async slugMap(ids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>()
    if (!ids.length) return map
    const projects = await this.getJson<ModrinthProject[]>(
      `${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify(ids))}`
    ).catch(() => undefined)
    for (const p of projects ?? []) {
      if (p.id) map.set(p.id, p.slug)
    }
    return map
  }

  /**
   * 从 OptiFine 官网解析下载链接。
   *
   * 官网无 API，下载链是两跳：
   *   downloads 页面 → adloadx?f=<文件名> → 页里带 token 的 downloadx?f=...&x=...
   * 只抓第一层是抓不到直链的（这里原来就写错了，等于 OptiFine 永远装不上）。
   */
  private async resolveOptifine(gameVersion: string): Promise<ShaderPackage | undefined> {
    try {
      const html = await this.http.text('https://optifine.net/downloads', { timeoutMs: 8_000 })
      // 正式版形如 OptiFine_1.21.1_HD_U_J1.jar；预览版带 preview_ 前缀，跳过
      const re = new RegExp(
        `(?:adloadx|downloadx)\\?f=(OptiFine_${escapeRe(gameVersion)}_HD_[A-Z]_[A-Z]\\d+)\\.jar`,
        'i'
      )
      const m = re.exec(html)
      if (!m) return undefined
      const fileName = `${m[1]}.jar`

      // adloadx 返回的是「5 秒后开始下载」的过渡页，真正的直链和 token 在里面
      const page = await this.http.text(
        `https://optifine.net/adloadx?f=${encodeURIComponent(fileName)}`,
        { timeoutMs: 8_000 }
      )
      const token = new RegExp(`downloadx\\?f=${escapeRe(fileName)}&x=([a-f0-9]+)`, 'i').exec(page)?.[1]
      const downloadUrl = token
        ? `https://optifine.net/downloadx?f=${encodeURIComponent(fileName)}&x=${token}`
        : `https://optifine.net/downloadx?f=${encodeURIComponent(fileName)}`

      return {
        slug: 'optifine',
        title: `OptiFine ${gameVersion}`,
        fileName,
        downloadUrl,
        size: 0,
        sha1: undefined
      }
    } catch {
      return undefined
    }
  }

  private async uniqueName(dir: string, fileName: string): Promise<string> {
    let candidate = fileName
    const base = fileName.replace(/\.jar$/i, '')
    let i = 1
    for (;;) {
      try {
        await fs.access(path.join(dir, candidate))
        candidate = `${base} (${i}).jar`
        i += 1
      } catch {
        return candidate
      }
    }
  }

  private async getJson<T>(url: string, attempts = 3): Promise<T | null> {
    for (let i = 0; i < attempts; i++) {
      try {
        const { data } = await this.http.json<T>(url, { timeoutMs: 12_000 })
        return data
      } catch {
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 600 * (i + 1)))
      }
    }
    return null
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
