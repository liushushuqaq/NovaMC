import path from 'node:path'
import fs from 'node:fs/promises'
import { GamePaths, detectPlatform, type PlatformInfo } from '../core/paths'
import { HttpClient } from '../core/http'
import { DownloadPool } from '../core/download'
import { ManifestService } from '../core/manifest'
import { VersionService } from '../core/version'
import { Installer } from '../core/installer'
import { InstanceStore } from '../core/instance'
import { ConfigStore } from '../core/config'
import { AccountStore } from '../core/auth'
import { ModrinthService } from '../core/modpack'
import { PackImporter } from '../core/packImport'
import { LaunchService } from '../core/launch'
import { detectJavaRuntimes, pickJava } from '../core/java'
import { javaBinCandidates, provisionJava } from '../core/javaProvision'
import { StorageService } from '../core/storage'
import { ModDependencyService } from '../core/modDeps'
import { ForgeService } from '../core/forge'
import { ShaderService } from '../core/shader'
import { TunnelService } from '../core/tunnel'
import type { MirrorConfig } from '../core/mirror'
import type { JavaRuntimeInfo } from '../core/types'

/** 受管运行时（provision 流程下载到 runtime/ 下）也要参与探测 */
class JavaService {
  constructor(
    private readonly paths: GamePaths,
    private readonly config: ConfigStore
  ) {}

  async detect(): Promise<JavaRuntimeInfo[]> {
    const cfg = await this.config.load()
    const custom: string[] = []
    try {
      const dirs = await fs.readdir(this.paths.runtimes)
      for (const dir of dirs) {
        for (const rel of javaBinCandidates(dir)) custom.push(path.join(this.paths.runtimes, rel))
      }
    } catch {
      /* 还没有受管运行时 */
    }
    if (cfg.javaPreference !== 'auto') custom.push(cfg.javaPreference)
    const list = await detectJavaRuntimes(custom)
    return list.map((j) => ({ ...j, managed: j.path.startsWith(this.paths.runtimes) }))
  }
}

/** 数据根目录的解析结果，界面要据此提示「绿色版 / 回落到用户目录」 */
export interface DataRoot {
  root: string
  /** true = 数据就在 exe 同级，拷走整个文件夹即可 */
  portable: boolean
  /** 非空表示原定目录不可写，已经回落到用户目录 */
  fallbackReason?: string
}

export interface AppContext {
  paths: GamePaths
  platform: PlatformInfo
  http: HttpClient
  pool: DownloadPool
  mirror: MirrorConfig
  config: ConfigStore
  accounts: AccountStore
  manifest: ManifestService
  versions: VersionService
  installer: Installer
  instances: InstanceStore
  modrinth: ModrinthService
  packs: PackImporter
  launcher: LaunchService
  java: JavaService
  storage: StorageService
  modDeps: ModDependencyService
  forge: ForgeService
  shader: ShaderService
  tunnel: TunnelService
  dataRoot: DataRoot
}

export async function createContext(dataRoot: DataRoot): Promise<AppContext> {
  const paths = new GamePaths(dataRoot.root)
  await paths.ensure()

  const platform = detectPlatform()
  const http = new HttpClient()
  const pool = new DownloadPool(http)
  const config = new ConfigStore(paths)
  const cfg = await config.load()
  pool.setConcurrency(cfg.concurrency)
  pool.setRetries(cfg.downloadRetries)
  pool.setTimeoutMs(cfg.downloadTimeoutSec * 1000)

  const mirror: MirrorConfig = { mode: cfg.mirror }
  const manifest = new ManifestService(http, paths, mirror)
  const versions = new VersionService(http, paths, manifest, mirror)
  const installer = new Installer(http, pool, paths, versions, mirror, platform)
  const instances = new InstanceStore(paths)
  const accounts = new AccountStore(paths, config)
  const forge = new ForgeService(http, pool, paths)
  const modrinth = new ModrinthService(http, pool, paths, versions, instances, {
    forge,
    getJava: async (major: number) => {
      const cfg = await config.load()
      const runtimes = await detectJavaRuntimes()
      const hit = pickJava(runtimes, major, cfg.javaPreference)
      if (hit) return hit.path
      return provisionJava(major, paths, pool, http, platform, mirror.mode)
    }
  })
  const packs = new PackImporter(http, pool, paths)
  const launcher = new LaunchService()
  const java = new JavaService(paths, config)
  const storage = new StorageService(paths)
  const modDeps = new ModDependencyService(http, pool, paths)
  const shader = new ShaderService(http, pool, paths)
  const tunnel = new TunnelService(http)

  return {
    paths,
    platform,
    http,
    pool,
    mirror,
    config,
    accounts,
    manifest,
    versions,
    installer,
    instances,
    modrinth,
    packs,
    launcher,
    java,
    storage,
    modDeps,
    forge,
    shader,
    tunnel,
    dataRoot
  }
}
