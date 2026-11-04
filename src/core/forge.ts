import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { DownloadPool, DownloadTask } from './download'
import type { VersionJson, Library } from './types'
import { fail } from './errors'
import {
  parseMavenMetadata,
  runProcessor,
  type ProcessorDef,
  type ProcessorContext
} from './processor'

export type ForgeFamily = 'forge' | 'neoforge'

export interface LoaderVersion {
  /** 完整的版本标识，如 1.21.1-52.0.40 或 21.1.172 */
  id: string
  /** 对应的 Minecraft 版本 */
  mcVersion: string
  /** 构建号 */
  build: string
  /** 是不是预发布（-beta / -rc） */
  prerelease: boolean
}

export interface InstallForgeOptions {
  /** 受管 JRE 的 java 可执行文件 */
  javaPath: string
  /** 进度回调 */
  onProgress?: (label: string, done: number, total: number) => void
}

const SOURCES: Record<ForgeFamily, string[]> = {
  // 官方源和镜像都会间歇性抽风，必须轮询 + 重试，不能写死一个。
  // 注意：镜像放前面——国内访问 maven.minecraftforge.net / maven.neoforged.net
  // 常被墙（连接挂起 10s+ 才超时），先撞镜像能秒回，坏源只作为兜底。
  forge: [
    'https://bmclapi2.bangbang93.com/maven/net/minecraftforge/forge/maven-metadata.xml',
    'https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml'
  ],
  neoforge: [
    'https://bmclapi2.bangbang93.com/maven/net/neoforged/neoforge/maven-metadata.xml',
    'https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml'
  ]
}

/**
 * 各源的 group 路径。
 * 安装包在 group 下面还要再带一层 artifact 名：
 *   net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar
 */
const GROUP_PATH: Record<ForgeFamily, { path: string; sources: string[] }> = {
  forge: {
    path: 'net/minecraftforge/forge',
    sources: ['https://bmclapi2.bangbang93.com/maven', 'https://maven.minecraftforge.net']
  },
  neoforge: {
    path: 'net/neoforged/neoforge',
    sources: [
      'https://bmclapi2.bangbang93.com/maven',
      'https://maven.neoforged.net/releases'
    ]
  }
}

/** 工具 jar（processor 用的）从哪下 */
const TOOL_BASE: Record<ForgeFamily, string[]> = {
  forge: [
    'https://bmclapi2.bangbang93.com/maven',
    'https://maven.minecraftforge.net'
  ],
  neoforge: [
    'https://bmclapi2.bangbang93.com/maven',
    'https://maven.neoforged.net/releases'
  ]
}

/**
 * Forge / NeoForge 安装服务。
 *
 * 跟 Fabric 的根本区别：不能只下一份 JSON。installer.jar 里装着要跑的
 * Java 工具链，客户端必须执行「重命名」和「打补丁」才能得到能启动的 jar。
 */
/** 元数据缓存 10 分钟 */
const META_TTL_MS = 10 * 60_000
/** 轮询几轮（每轮换一个源） */
const META_ROUNDS = 6

export class ForgeService {
  /** family -> 拉到的版本列表 */
  private readonly metaCache = new Map<ForgeFamily, { at: number; versions: string[] }>()

  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths
  ) {}

  /**
   * 列出某个 Minecraft 版本可用的加载器版本。
   *
   * 源不稳定，这里对每个源做多轮重试；全挂了才报错。
   */
  async listLoaders(family: ForgeFamily, mcVersion: string): Promise<LoaderVersion[]> {
    const versions = await this.fetchVersions(family)
    const out: LoaderVersion[] = []

    for (const v of versions) {
      const parsed = this.parseVersion(family, v)
      if (!parsed) continue
      if (parsed.mcVersion !== mcVersion) continue
      out.push(parsed)
    }

    // 同一 MC 版本下按构建号倒序，新的在前
    out.sort((a, b) => this.compareBuild(b.build, a.build))
    return out
  }

  /** 所有能推断出 MC 版本的加载器，按 MC 版本分组 */
  async listAll(family: ForgeFamily): Promise<Map<string, LoaderVersion[]>> {
    const versions = await this.fetchVersions(family)
    const map = new Map<string, LoaderVersion[]>()
    for (const v of versions) {
      const parsed = this.parseVersion(family, v)
      if (!parsed) continue
      const list = map.get(parsed.mcVersion) ?? []
      list.push(parsed)
      map.set(parsed.mcVersion, list)
    }
    for (const list of map.values()) {
      list.sort((a, b) => this.compareBuild(b.build, a.build))
    }
    return map
  }

  /**
   * 拉取 maven-metadata.xml。
   *
   * 这些源在国内是「间歇性抽风」而不是「彻底不通」——同一个 URL 这次 502、
   * 下次就 200。所以策略是：轮询所有源，每个源多试几轮，都不行才报错。
   * 缓存 10 分钟，避免每次开界面都去打一遍。
   */
  private async fetchVersions(family: ForgeFamily): Promise<string[]> {
    const cached = this.metaCache.get(family)
    if (cached && Date.now() - cached.at < META_TTL_MS) return cached.versions

    const sources = SOURCES[family]
    let lastError: unknown = null

    // 并发竞速：同一轮里同时打所有源，谁先成功用谁。
    // 这样镜像（0.1s）不会被坏掉的官方源（10s+ 超时）串行拖住。
    for (let round = 0; round < META_ROUNDS; round++) {
      const results = await Promise.allSettled(
        sources.map(async (url) => {
          // maven-metadata.xml 是 XML，不能走 json()
          const xml = await this.http.text(url, { timeoutMs: 15_000 })
          return parseMavenMetadata(xml)
        })
      )
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value.length) {
          this.metaCache.set(family, { at: Date.now(), versions: r.value })
          return r.value
        }
        if (r.status === 'rejected') lastError = r.reason
      }
      // 全挂才歇一下再试下一轮，避免空转
      await new Promise((r) => setTimeout(r, 500))
    }
    throw fail(
      'E_LOADER_LIST_FAILED',
      `拉取 ${family === 'forge' ? 'Forge' : 'NeoForge'} 版本列表失败（已尝试 ${sources.length} 个源 × ${META_ROUNDS} 轮）。${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    )
  }

  /**
   * 从版本号推断 MC 版本。
   * - Forge：`1.21.1-52.0.40` → MC 1.21.1
   * - NeoForge 旧制：`21.1.172` → MC 1.21.1
   * - NeoForge 新制（26.x）：版本号本身是游戏版本，推断不出来，跳过
   */
  private parseVersion(family: ForgeFamily, v: string): LoaderVersion | null {
    const prerelease = /-(beta|rc|alpha|dev)/i.test(v)
    if (family === 'forge') {
      const m = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(v)
      if (!m) return null
      return { id: v, mcVersion: m[1], build: m[2], prerelease }
    }
    const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
    if (!m) return null
    // 21.1.172 → 1.21.1；26.1.2.71 是四段，推断不出来
    return { id: v, mcVersion: `1.${m[1]}.${m[2]}`, build: m[3], prerelease }
  }

  /** 构建号比较：按数字分段比，"52.0.40" 比 "52.0.9" 新 */
  private compareBuild(a: string, b: string): number {
    const pa = a.split(/[.\-+]/).map((n) => Number.parseInt(n, 10))
    const pb = b.split(/[.\-+]/).map((n) => Number.parseInt(n, 10))
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const x = pa[i] ?? 0
      const y = pb[i] ?? 0
      if (x !== y) return x - y
    }
    return 0
  }

  /**
   * 安装加载器。
   *
   * 流程：下 installer → 解出 version.json / install_profile.json →
   * 下依赖库 → 跑 processor 生成 patched jar → 写版本目录。
   */
  async install(
    family: ForgeFamily,
    loaderVersion: string,
    opts: InstallForgeOptions
  ): Promise<{ versionId: string }> {
    const workDir = path.join(this.paths.root, 'tmp', `${family}-${loaderVersion}`)
    await fs.rm(workDir, { recursive: true, force: true })
    await fs.mkdir(workDir, { recursive: true })

    // 1. 下载 installer
    //    maven-metadata 里列出的版本不一定都有 installer（构建可能被撤回），
    //    最新的那个下不到就自动退到上一个，用户不该为这个卡住。
    const installerPath = path.join(workDir, `${family}-${loaderVersion}-installer.jar`)
    try {
      await this.downloadOne(family, `${family}-${loaderVersion}-installer.jar`, installerPath, opts)
    } catch (e) {
      const fallback = await this.findInstallable(family, loaderVersion, opts)
      if (!fallback) {
        throw fail(
          'E_INSTALLER_MISSING',
          `${loaderVersion} 的安装包下载不到（可能是构建被撤回），换个版本试试`
        )
      }
      opts.onProgress?.(`${loaderVersion} 没有安装包，改用 ${fallback}`, 0, 1)
      await fs.rm(workDir, { recursive: true, force: true })
      await fs.mkdir(workDir, { recursive: true })
      return this.install(family, fallback, opts)
    }

    // 2. 解出配置
    const { version, profile } = await this.readInstaller(installerPath)
    const versionId = version.id

    // 3. 父版本（Minecraft 本体）必须先落地
    if (version.inheritsFrom) {
      const parentJson = path.join(this.paths.versionDir(version.inheritsFrom), `${version.inheritsFrom}.json`)
      const exists = await fs.access(parentJson).then(() => true).catch(() => false)
      if (!exists) {
        throw fail(
          'E_PARENT_MISSING',
          `先装好 Minecraft ${version.inheritsFrom} 再装 ${family === 'forge' ? 'Forge' : 'NeoForge'}`
        )
      }
    }

    // 4. 下载依赖库（install_profile.libraries 里的工具 + 版本库）
    await this.installLibraries(profile, family, opts)

    // 5. 跑 processor，产出 patched jar
    await this.runProcessors(profile, installerPath, workDir, versionId, opts)

    // 6. 落盘版本
    const dir = this.paths.versionDir(versionId)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(this.paths.versionJson(versionId), JSON.stringify(version, null, 2))
    await fs.writeFile(this.paths.versionCompleteMark(versionId), 'ok')

    await fs.rm(workDir, { recursive: true, force: true })
    return { versionId }
  }

  /**
   * 找一个真的有 installer 的邻近版本。
   * 只在同一个 MC 版本下往后找，不跨版本。
   */
  private async findInstallable(
    family: ForgeFamily,
    loaderVersion: string,
    opts: InstallForgeOptions
  ): Promise<string | null> {
    const mc = loaderVersion.split('-')[0]
    const list = await this.listLoaders(family, mc)
    const idx = list.findIndex((v) => v.id === loaderVersion)
    if (idx < 0) return null

    for (let i = idx + 1; i < Math.min(idx + 6, list.length); i++) {
      const cand = list[i]
      const fileName = `${family}-${cand.id}-installer.jar`
      const dest = path.join(this.paths.root, 'tmp', `probe-${cand.id}.jar`)
      try {
        await this.downloadOne(family, fileName, dest, { ...opts, onProgress: undefined })
        await fs.rm(dest, { force: true })
        return cand.id
      } catch {
        await fs.rm(dest, { force: true }).catch(() => {})
      }
    }
    return null
  }

  private async readInstaller(installerPath: string): Promise<{ version: VersionJson; profile: InstallProfile }> {
    let zip: AdmZip
    try {
      zip = new AdmZip(installerPath)
    } catch {
      throw fail('E_INSTALLER_INVALID', '安装器文件损坏，无法读取')
    }
    const vEntry = zip.getEntry('version.json')
    const pEntry = zip.getEntry('install_profile.json')
    if (!vEntry || !pEntry) {
      throw fail('E_INSTALLER_INVALID', '安装器里没有 version.json / install_profile.json')
    }
    try {
      const version = JSON.parse(zip.readAsText(vEntry)) as VersionJson
      const profile = JSON.parse(zip.readAsText(pEntry)) as InstallProfile
      return { version, profile }
    } catch {
      throw fail('E_INSTALLER_INVALID', '安装器里的配置文件解析失败')
    }
  }

  /** 下载 install_profile 里的 libraries（工具 jar 也在这里） */
  private async installLibraries(
    profile: InstallProfile,
    family: ForgeFamily,
    opts: InstallForgeOptions
  ): Promise<void> {
    const tasks: DownloadTask[] = []
    for (const lib of profile.libraries ?? []) {
      // install_profile 的 downloads.artifact.path 给了准确的文件名，
      // 尤其 @zip 这类「打包类型」后缀，自己拼会拼错扩展名。优先用它。
      const mavenPath = lib.downloads?.artifact?.path ?? forgeLibPath(lib.name)
      const dest = this.paths.library(mavenPath)
      const urls = this.toolUrls(family, mavenPath)
      tasks.push({
        url: lib.downloads?.artifact?.url ?? urls[0],
        mirrors: lib.downloads?.artifact?.url ? urls : urls.slice(1),
        dest,
        sha1: lib.downloads?.artifact?.sha1,
        size: lib.downloads?.artifact?.size,
        label: lib.name
      })
    }
    if (!tasks.length) return

    opts.onProgress?.('下载加载器依赖', 0, tasks.length)
    await this.pool.run(
      tasks,
      (s) => opts.onProgress?.(`下载加载器依赖 ${s.current}`, s.doneFiles, s.totalFiles),
      { tolerateFailures: false }
    )
  }

  /** 执行 processor 链，产出 patched jar */
  private async runProcessors(
    profile: InstallProfile,
    installerPath: string,
    workDir: string,
    versionId: string,
    opts: InstallForgeOptions
  ): Promise<void> {
    const processors = profile.processors ?? []
    // 只要没有限定端，或者限定了 client 的
    const clientProcs = processors.filter((p) => !p.sides || p.sides.includes('client'))
    if (!clientProcs.length) {
      throw fail('E_NO_PROCESSOR', '安装器里没有客户端处理器，无法生成可启动的版本')
    }

    // 中间产物都放在临时目录里，失败了就整个删掉，不留垃圾
    const mcUnpacked = path.join(workDir, 'mc-unpacked')
    const mcOff = path.join(workDir, 'mc-off')
    const mojmaps = path.join(workDir, 'mojmaps.txt')
    const binpatch = path.join(workDir, 'client.lzma')
    const finalJar = this.paths.versionJar(versionId)

    // 补丁数据从 installer 里取
    await this.extractData(installerPath, workDir)

    // processor 的工具 jar 依赖 gson / joptsimple 等库，classpath 必须带上
    // 已下载的全部依赖 jar（递归收集，不能只带一层目录）
    const depJars = await this.collectJars(this.paths.libraries)

    const ctx: ProcessorContext = {
      installer: installerPath,
      root: this.paths.root,
      minecraftJar: this.paths.versionJar(profile.minecraft ?? ''),
      side: 'client',
      mcUnpacked,
      mcOff,
      mojmaps,
      binpatch,
      patched: finalJar
    }

    for (let i = 0; i < clientProcs.length; i++) {
      const def = clientProcs[i]
      opts.onProgress?.(`执行处理器 ${i + 1}/${clientProcs.length}`, i, clientProcs.length)
      await runProcessor(
        { jar: def.jar, class: def.class, args: def.args ?? [] },
        ctx,
        {
          javaPath: opts.javaPath,
          classpathRoots: [this.paths.libraries],
          classpathJars: depJars,
          cwd: workDir,
          timeoutMs: 15 * 60_000
        }
      )
    }

    // 处理器必须真的产出了 jar，否则启动时只会报 ClassNotFound
    const ok = await fs.stat(finalJar).then((st) => st.size > 0).catch(() => false)
    if (!ok) {
      throw fail('E_NO_PATCHED_JAR', '处理器跑完了，但没生成可启动的 jar')
    }
  }

  /** 从 installer 里取出补丁数据 */
  private async extractData(installerPath: string, workDir: string): Promise<void> {
    const zip = new AdmZip(installerPath)
    const names = zip.getEntries().map((e) => e.entryName)
    const wanted = names.find((n) => /^data\/client\.lzma$/i.test(n))
    if (!wanted) {
      throw fail('E_NO_PATCH', '安装器里没有补丁数据（data/client.lzma）')
    }
    const buf = zip.readFile(wanted)
    if (!buf) {
      throw fail('E_NO_PATCH', '读取补丁数据失败')
    }
    await fs.writeFile(path.join(workDir, 'client.lzma'), buf)
  }

  /** 递归收集目录下所有 jar 的绝对路径 */
  private async collectJars(dir: string): Promise<string[]> {
    const out: string[] = []
    const stack = [dir]
    while (stack.length) {
      const d = stack.pop()!
      let entries
      try {
        entries = await fs.readdir(d, { withFileTypes: true })
      } catch {
        continue
      }
      for (const e of entries) {
        const full = path.join(d, e.name)
        if (e.isDirectory()) stack.push(full)
        else if (e.name.endsWith('.jar')) out.push(full)
      }
    }
    return out
  }

  private async downloadOne(
    family: ForgeFamily,
    fileName: string,
    dest: string,
    opts: InstallForgeOptions
  ): Promise<void> {
    const urls = this.installerUrls(family, fileName)
    opts.onProgress?.(`下载 ${fileName}`, 0, 1)
    await this.pool.run(
      [
        {
          url: urls[0],
          mirrors: urls.slice(1),
          dest,
          label: fileName
        }
      ],
      (s) => opts.onProgress?.(`下载 ${s.current}`, s.doneFiles, s.totalFiles),
      { tolerateFailures: false }
    )
  }

  /**
   * Maven 布局：group/artifact/version/file。
   * GROUP_PATH 已经包含了 group + artifact（net/minecraftforge/forge），
   * 这里只需再补 version 目录。
   *   forge-1.21.1-52.1.20-installer.jar
   *     → net/minecraftforge/forge/1.21.1-52.1.20/forge-1.21.1-52.1.20-installer.jar
   */
  private installerUrls(family: ForgeFamily, fileName: string): string[] {
    const g = GROUP_PATH[family]
    // 提取 version：forge-1.21.1-52.1.21-installer.jar → 1.21.1-52.1.21
    const m = /^[a-z]+-(.+)-installer\.jar$/.exec(fileName)
    const version = m ? m[1] : null
    return g.sources.map((base) =>
      version ? `${base}/${g.path}/${version}/${fileName}` : `${base}/${g.path}/${fileName}`
    )
  }

  private toolUrls(family: ForgeFamily, mavenPath: string): string[] {
    return TOOL_BASE[family].map((b) => `${b}/${mavenPath}`)
  }
}

export interface InstallProfile {
  spec?: number
  profile?: string
  version?: string
  path?: string
  minecraft?: string
  json?: string
  processors?: ProcessorDef[]
  libraries?: (Library & { downloads?: { artifact?: { sha1?: string; size?: number; url?: string } } })[]
  data?: Record<string, { client?: string; server?: string }>
}

/**
 * Forge 依赖坐标里的 `@zip` / `@json` 是「打包类型」不是 classifier。
 * 例如 `de.oceanlabs.mcp:mcp_config:1.21.1-20240808.132146@zip`
 * 的真实文件是 `mcp_config-1.21.1-20240808.132146.zip`。
 * `mavenPathOf` 会把 `@zip` 当 classifier 拼成 `...-zip.jar`，这里单独处理。
 */
export function forgeLibPath(name: string): string {
  // 拆出末尾的 @packaging 后缀
  const at = name.lastIndexOf('@')
  let packaging: string | null = null
  let base = name
  if (at > 0) {
    packaging = name.slice(at + 1)
    base = name.slice(0, at)
  }
  const [group, artifact, version, classifier] = base.split(':')
  if (!group || !artifact || !version) throw fail('E_LIBRARY_NAME', `无法解析依赖坐标：${name}`)

  const ext = packaging === 'zip' ? 'zip' : 'jar'
  const file = classifier
    ? `${artifact}-${version}-${classifier}.${ext}`
    : `${artifact}-${version}.${ext}`
  return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
}
