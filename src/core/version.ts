import fs from 'node:fs/promises'
import path from 'node:path'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { MirrorConfig } from './mirror'
import { fabricMetaUrls, versionJsonUrls } from './mirror'
import type { ManifestService } from './manifest'
import type { ArgEntry, Library, ResolvedVersion, VersionJson } from './types'
import { fail, wrap } from './errors'

export class VersionService {
  constructor(
    private readonly http: HttpClient,
    private readonly paths: GamePaths,
    private readonly manifest: ManifestService,
    private readonly mirror: MirrorConfig
  ) {}

  /** 读取本地缓存的 version.json；没有则按清单里的 url 拉取并落地 */
  async getJson(id: string): Promise<VersionJson> {
    const local = this.paths.versionJson(id)
    try {
      return JSON.parse(await fs.readFile(local, 'utf8')) as VersionJson
    } catch {
      /* 继续远程拉取 */
    }

    const summary = await this.manifest.find(id)
    const { primary, mirrors } = versionJsonUrls(id, summary.url, this.mirror.mode)
    let lastError: unknown
    for (const url of [primary, ...mirrors]) {
      try {
        const res = await this.http.raw(url, { timeoutMs: 20_000 })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        const json = JSON.parse(text) as VersionJson
        await fs.mkdir(this.paths.versionDir(id), { recursive: true })
        await fs.writeFile(local, JSON.stringify(json, null, 2))
        return json
      } catch (e) {
        lastError = e
      }
    }
    throw wrap('E_VERSION_JSON', lastError, `无法获取 ${id} 的版本描述`)
  }

  /** 沿 inheritsFrom 链合并成可直接启动的有效版本 */
  async resolve(id: string): Promise<ResolvedVersion> {
    const chain: VersionJson[] = []
    let cursor: string | undefined = id
    const guard = new Set<string>()
    while (cursor) {
      if (guard.has(cursor)) throw fail('E_VERSION_LOOP', `版本继承链存在循环：${cursor}`)
      guard.add(cursor)
      const json = await this.getJson(cursor)
      chain.push(json)
      cursor = json.inheritsFrom
    }
    return mergeChain(chain)
  }

  async listFabricLoaders(gameVersion: string): Promise<{ version: string; stable: boolean }[]> {
    const data = await this.fabricGet<{ loader: { version: string; stable: boolean } }[]>(
      `v2/versions/loader/${encodeURIComponent(gameVersion)}`
    )
    return data.map((d) => ({ version: d.loader.version, stable: d.loader.stable }))
  }

  /**
   * Fabric meta 按镜像模式依次尝试。
   * 官方源在国内经常连不上，first attempt 给短超时，别让用户干等 20 秒。
   */
  private async fabricGet<T>(pathname: string): Promise<T> {
    const { primary, mirrors } = fabricMetaUrls(pathname, this.mirror.mode)
    const attempts = [
      { url: primary, timeoutMs: 8_000 },
      ...mirrors.map((url) => ({ url, timeoutMs: 15_000 }))
    ]
    let last: unknown = null
    for (const attempt of attempts) {
      try {
        const { data } = await this.http.json<T>(attempt.url, { timeoutMs: attempt.timeoutMs })
        return data
      } catch (e) {
        last = e
      }
    }
    throw fail(
      'E_FABRIC_UNREACHABLE',
      `连不上 Fabric 服务（官方与镜像都试过了），请检查网络后重试。最后错误：${
        last instanceof Error ? last.message : String(last)
      }`
    )
  }

  /** Fabric 官方 profile 直接就是一份带 inheritsFrom 的 version.json，落盘即可 */
  async installFabric(gameVersion: string, loaderVersion?: string): Promise<{ versionId: string; loaderVersion: string }> {
    let loader = loaderVersion
    if (!loader) {
      const list = await this.listFabricLoaders(gameVersion)
      const stable = list.find((l) => l.stable) ?? list[0]
      if (!stable) throw fail('E_LOADER_NOT_FOUND', `${gameVersion} 没有可用的 Fabric 加载器`)
      loader = stable.version
    }

    const data = await this.fabricGet<VersionJson>(
      `v2/versions/loader/${encodeURIComponent(gameVersion)}/${encodeURIComponent(loader)}/profile/json`
    )
    if (!data?.id) throw fail('E_LOADER_NOT_FOUND', 'Fabric 返回了空的 profile')

    // 父版本必须先落地，否则启动时解析继承链会失败
    if (data.inheritsFrom) await this.getJson(data.inheritsFrom)

    const dir = this.paths.versionDir(data.id)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.paths.versionJson(data.id), JSON.stringify(data, null, 2))
    return { versionId: data.id, loaderVersion: loader }
  }

  async remove(id: string): Promise<void> {
    await fs.rm(this.paths.versionDir(id), { recursive: true, force: true })
  }

  /** 已安装版本：目录下有 json 且（有 jar 或继承自别的版本） */
  async listInstalled(): Promise<string[]> {
    try {
      const entries = await fs.readdir(this.paths.versions, { withFileTypes: true })
      return entries.filter((e) => e.isDirectory()).map((e) => e.name)
    } catch {
      return []
    }
  }

  /**
   * 是否装完了。
   * 只判断 jar 是否存在会把"下到一半中断"的版本也算成已安装，用户点启动才发现要重下，
   * 所以以安装器最后写入的完成标记为准。
   */
  async isComplete(id: string): Promise<boolean> {
    try {
      await this.getJson(id)
      await fs.access(this.paths.versionCompleteMark(id))
      return true
    } catch {
      return false
    }
  }

  async markComplete(id: string, info: { files: number; bytes: number }): Promise<void> {
    await fs.mkdir(this.paths.versionDir(id), { recursive: true })
    await fs.writeFile(
      this.paths.versionCompleteMark(id),
      JSON.stringify({ id, at: new Date().toISOString(), ...info }),
      'utf8'
    )
  }
}

/** 把 inheritFrom 链合并：子版本优先，libraries 按 group:artifact 去重 */
export function mergeChain(chain: VersionJson[]): ResolvedVersion {
  if (!chain.length) throw fail('E_VERSION_NOT_FOUND', '版本链为空')
  const child = chain[0]
  const root = chain[chain.length - 1]
  const pick = <K extends keyof VersionJson>(key: K): VersionJson[K] | undefined => {
    for (const v of chain) if (v[key] !== undefined) return v[key]
    return undefined
  }

  const libraries = dedupeLibraries(chain.flatMap((v) => v.libraries ?? []))
  const args = mergeArguments(chain)
  const clientHost = chain.find((v) => v.downloads?.client)

  const assetIndex = pick('assetIndex')
  if (!assetIndex) throw fail('E_VERSION_JSON', '版本缺少 assetIndex 字段')

  return {
    id: child.id,
    type: child.type ?? root.type,
    mainClass: pick('mainClass') ?? 'net.minecraft.client.main.Main',
    assets: pick('assets') ?? assetIndex.id,
    assetIndex,
    libraries,
    arguments: args,
    minecraftArguments: pick('minecraftArguments'),
    javaMajor: pick('javaVersion')?.majorVersion ?? inferJavaMajor(root.id),
    clientJarId: child.jar ?? clientHost?.id ?? child.id,
    client: clientHost!.downloads.client
  }
}

function dedupeLibraries(list: Library[]): Library[] {
  const seen = new Map<string, Library>()
  const order: string[] = []
  for (const lib of list) {
    // 去重键必须带上 classifier：同一坐标的主 jar 与 natives 变体共享 group:artifact，
    // 只按 group:artifact 去重会把 jtracy / lwjgl 的主 jar 挤掉，启动时直接 NoClassDefFoundError
    const [group, artifact, , classifier = ''] = lib.name.split(':')
    const key = `${group}:${artifact}:${classifier}`
    // 子版本在链首，先到的实现优先
    if (seen.has(key)) continue
    order.push(key)
    seen.set(key, lib)
  }
  return order.map((k) => seen.get(k)!)
}

function mergeArguments(chain: VersionJson[]): { game: ArgEntry[]; jvm: ArgEntry[] } | undefined {
  const hasAny = chain.some((v) => v.arguments)
  if (!hasAny) return undefined

  // 游戏参数：父版本在前（--username 等通用参数），子版本追加（--launchTarget 等）
  const game = [...chain].reverse().flatMap((v) => v.arguments?.game ?? [])
  // JVM 参数：子版本在前（-DFabricMcEmu 等），并去掉重复的 -cp 对
  const jvm = dedupeClasspathArg(chain.flatMap((v) => v.arguments?.jvm ?? []))
  return { game, jvm }
}

function dedupeClasspathArg(args: ArgEntry[]): ArgEntry[] {
  const out: ArgEntry[] = []
  let seenCp = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '-cp' || a === '-classpath') {
      if (seenCp) {
        i++ // 跳过它后面的路径
        continue
      }
      seenCp = true
    }
    out.push(a)
  }
  return out
}

export function inferJavaMajor(versionId: string): number {
  const m = /^1\.(\d+)/.exec(versionId)
  if (!m) return 8
  const minor = Number(m[1])
  if (minor >= 20) return 21
  if (minor >= 18) return 17
  if (minor >= 17) return 16
  return 8
}

export function resolveVersionDir(paths: GamePaths, id: string): string {
  return path.dirname(paths.versionJson(id))
}
