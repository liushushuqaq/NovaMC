import fs from 'node:fs/promises'
import path from 'node:path'
import type { HttpClient } from './http'
import type { GamePaths, PlatformInfo } from './paths'
import type { MirrorConfig } from './mirror'
import { assetUrls, clientJarUrls, libraryUrls } from './mirror'
import type { DownloadPool, DownloadTask, TickStats } from './download'
import { verifyFile } from './download'
import type { VersionService } from './version'
import { nativeClassifier, extractNatives, resetDir } from './natives'
import { rulesAllow, type OsContext } from './rules'
import type { Library, ResolvedVersion } from './types'
import { fail, wrap } from './errors'

export type InstallStage = 'resolve' | 'client' | 'libraries' | 'assets' | 'natives'

export interface InstallHooks {
  stage(stage: InstallStage, label?: string): void
  tick(stage: InstallStage, stats: TickStats): void
}

interface PhaseResult {
  total: number
  bytes: number
  failed: number
}

interface LibraryPlan {
  artifact: { path: string; url: string; sha1?: string; size?: number } | null
  native: { path: string; url: string; sha1?: string; size?: number } | null
  exclude: string[]
}

export class Installer {
  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths,
    private readonly versions: VersionService,
    private readonly mirror: MirrorConfig,
    private readonly platform: PlatformInfo
  ) {}

  private get ctx(): OsContext {
    return {
      name: this.platform.name,
      arch: this.platform.arch,
      version: this.platform.version,
      features: {}
    }
  }

  async install(versionId: string, hooks: InstallHooks): Promise<{ files: number; bytes: number; failed: number }> {
    hooks.stage('resolve', '解析版本清单')
    const resolved = await this.versions.resolve(versionId)
    let files = 0
    let bytes = 0
    let failed = 0
    const acc = (r: PhaseResult): void => {
      files += r.total
      bytes += r.bytes
      failed += r.failed
    }

    // 1) 客户端 jar 与资源索引：其它一切都依赖这两份元数据
    const metaTasks: DownloadTask[] = []
    if (resolved.client) {
      const u = clientJarUrls(resolved.clientJarId, resolved.client.url, this.mirror.mode)
      metaTasks.push({
        url: u.primary,
        mirrors: u.mirrors,
        dest: this.paths.versionJar(resolved.clientJarId),
        sha1: resolved.client.sha1,
        size: resolved.client.size,
        label: `${resolved.clientJarId}.jar`
      })
    }
    metaTasks.push({
      url: resolved.assetIndex.url,
      dest: this.paths.assetIndex(resolved.assetIndex.id),
      sha1: resolved.assetIndex.sha1,
      size: resolved.assetIndex.size,
      label: `assets-${resolved.assetIndex.id}.json`
    })
    acc(await this.runPhase('client', metaTasks, hooks))

    // 2) 依赖库（含 legacy natives 的 classifier jar）
    const plans = resolved.libraries
      .filter((lib) => rulesAllow(lib.rules, this.ctx))
      .map((lib) => this.planLibrary(lib))
      .filter((p) => p.artifact || p.native)

    const libTasks: DownloadTask[] = []
    const nativeJars: { file: string; exclude: string[] }[] = []
    for (const plan of plans) {
      if (plan.artifact) {
        const u = libraryUrls(plan.artifact.path, plan.artifact.url, this.mirror.mode)
        libTasks.push({
          url: u.primary,
          mirrors: u.mirrors,
          dest: this.paths.library(plan.artifact.path),
          sha1: plan.artifact.sha1,
          size: plan.artifact.size,
          label: path.basename(plan.artifact.path)
        })
      }
      if (plan.native) {
        const u = libraryUrls(plan.native.path, plan.native.url, this.mirror.mode)
        libTasks.push({
          url: u.primary,
          mirrors: u.mirrors,
          dest: this.paths.library(plan.native.path),
          sha1: plan.native.sha1,
          size: plan.native.size,
          label: path.basename(plan.native.path)
        })
        nativeJars.push({ file: this.paths.library(plan.native.path), exclude: plan.exclude })
      }
    }
    acc(await this.runPhase('libraries', libTasks, hooks))

    // 3) 资源对象（共享池，多实例共用同一份）
    hooks.stage('assets', '读取资源索引')
    const assetTasks = await this.buildAssetTasks(resolved)
    // 资源文件缺几个不影响进游戏（顶多没声音），不能因此让整次安装白干
    acc(await this.runPhase('assets', assetTasks, hooks, { tolerateFailures: true }))

    // 4) 解压 legacy natives
    if (nativeJars.length) {
      hooks.stage('natives', '解压本地库')
      const dir = this.paths.nativesDir(resolved.id)
      await resetDir(dir)
      await extractNatives(nativeJars, dir)
    }

    // 5) 老版本需要 virtual/legacy 目录
    await this.materializeVirtualAssets(resolved)

    // 只有这里是全部走完的地方，完成标记写在这里；中断的安装不会被误判为已安装
    await this.versions.markComplete(resolved.id, { files, bytes })
    return { files, bytes, failed }
  }

  /** 一个阶段 = 一批任务 = 一条独立进度，避免把不同量级的东西混进同一个分母 */
  private async runPhase(
    stage: InstallStage,
    tasks: DownloadTask[],
    hooks: InstallHooks,
    opts?: { tolerateFailures?: boolean }
  ): Promise<PhaseResult> {
    if (!tasks.length) return { total: 0, bytes: 0, failed: 0 }
    hooks.stage(stage)
    const res = await this.pool.run(tasks, (stats) => hooks.tick(stage, stats), opts)
    return { total: res.total, bytes: res.bytes, failed: res.failed }
  }

  /** 只校验不下载，用于启动前的完整性检查 */
  async verify(versionId: string, opts: { assets?: boolean } = {}): Promise<{ dirty: string[]; total: number }> {
    const resolved = await this.versions.resolve(versionId)
    const targets: { dest: string; sha1?: string }[] = []

    if (resolved.client) {
      targets.push({ dest: this.paths.versionJar(resolved.clientJarId), sha1: resolved.client.sha1 })
    }
    for (const lib of resolved.libraries) {
      if (!rulesAllow(lib.rules, this.ctx)) continue
      const plan = this.planLibrary(lib)
      if (plan.artifact) targets.push({ dest: this.paths.library(plan.artifact.path), sha1: plan.artifact.sha1 })
      if (plan.native) targets.push({ dest: this.paths.library(plan.native.path), sha1: plan.native.sha1 })
    }

    const dirty: string[] = []
    for (const t of targets) {
      if (!(await verifyFile(t.dest, t.sha1))) dirty.push(t.dest)
    }
    if (opts.assets === false) return { dirty, total: targets.length }

    // 资源索引里的对象数量太大，这里只抽检 200 个
    try {
      const index = await this.readAssetIndex(resolved)
      const hashes = Object.values(index.objects).map((o) => o.hash)
      const sample = hashes.filter((_, i) => i % Math.max(1, Math.floor(hashes.length / 200)) === 0)
      for (const hash of sample) {
        if (!(await verifyFile(this.paths.assetObject(hash), hash))) dirty.push(hash)
      }
      return { dirty, total: targets.length + sample.length }
    } catch {
      return { dirty, total: targets.length }
    }
  }

  private planLibrary(lib: Library): LibraryPlan {
    const mavenPath = mavenPathOf(lib.name)
    let artifact: LibraryPlan['artifact'] = null
    let native: LibraryPlan['native'] = null

    if (lib.downloads?.artifact) {
      artifact = {
        path: lib.downloads.artifact.path ?? mavenPath,
        url: lib.downloads.artifact.url,
        sha1: lib.downloads.artifact.sha1,
        size: lib.downloads.artifact.size
      }
    } else if (lib.name && path.extname(mavenPath) === '.jar') {
      // Fabric 的 profile 只给 maven 根地址，没有 downloads 字段
      const base = (lib as Library & { url?: string }).url
      if (base) artifact = { path: mavenPath, url: `${base.replace(/\/$/, '')}/${mavenPath}` }
    }

    const classifier = nativeClassifier(lib, this.platform.name, this.platform.arch)
    if (classifier && lib.downloads?.classifiers) {
      const c = lib.downloads.classifiers[classifier]
      if (c) native = { path: c.path ?? mavenPath.replace(/\.jar$/, `-${classifier}.jar`), url: c.url, sha1: c.sha1, size: c.size }
    }

    return { artifact, native, exclude: lib.extract?.exclude ?? [] }
  }

  private async buildAssetTasks(resolved: ResolvedVersion): Promise<DownloadTask[]> {
    let index: { objects: Record<string, { hash: string; size: number }> }
    try {
      index = await this.readAssetIndex(resolved)
    } catch {
      return []
    }
    const tasks: DownloadTask[] = []
    for (const obj of Object.values(index.objects)) {
      const dest = this.paths.assetObject(obj.hash)
      const u = assetUrls(obj.hash, this.mirror.mode)
      tasks.push({
        url: u.primary,
        mirrors: u.mirrors,
        dest,
        sha1: obj.hash,
        size: obj.size,
        label: `assets/${obj.hash.slice(0, 8)}`
      })
    }
    return tasks
  }

  private async readAssetIndex(resolved: ResolvedVersion): Promise<{
    objects: Record<string, { hash: string; size: number }>
    virtual?: boolean
    map_to_resources?: boolean
  }> {
    const file = this.paths.assetIndex(resolved.assetIndex.id)
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'))
    } catch (e) {
      throw wrap('E_ASSET_INDEX', e, '资源索引缺失，请重新安装该版本')
    }
  }

  private async materializeVirtualAssets(resolved: ResolvedVersion): Promise<void> {
    let index: { objects: Record<string, { hash: string }>; virtual?: boolean; map_to_resources?: boolean }
    try {
      index = await this.readAssetIndex(resolved)
    } catch {
      return
    }
    if (!index.virtual && !index.map_to_resources) return
    for (const [name, obj] of Object.entries(index.objects)) {
      const target = path.join(this.paths.assetsVirtual(), name)
      try {
        await fs.access(target)
        continue
      } catch {
        /* 需要创建 */
      }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.copyFile(this.paths.assetObject(obj.hash), target).catch(() => {})
    }
  }
}

export function mavenPathOf(name: string): string {
  const [group, artifact, version, classifier] = name.split(':')
  if (!group || !artifact || !version) throw fail('E_LIBRARY_NAME', `无法解析依赖坐标：${name}`)
  const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}
