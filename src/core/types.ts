/**
 * NovaMC — 共享类型定义。
 * 该文件会被主进程与渲染进程同时引用，且只能是纯类型（不得 import 任何 node 模块），
 * 否则渲染层会被打进 fs / path 的实现。
 */

/* ------------------------------------------------------------------ 版本 */

export type VersionType = 'release' | 'snapshot' | 'old_beta' | 'old_alpha'

export interface VersionSummary {
  id: string
  type: VersionType
  url: string
  sha1: string
  releaseTime: string
  complianceLevel?: number
}

export interface VersionManifest {
  latest: { release: string; snapshot: string }
  versions: VersionSummary[]
}

export interface Artifact {
  path?: string
  sha1: string
  size: number
  url: string
}

export interface Rule {
  action: 'allow' | 'deny'
  os?: { name?: 'windows' | 'osx' | 'linux'; arch?: string; version?: string }
  features?: Record<string, boolean>
}

export type ArgEntry = string | { rules?: Rule[]; value: string | string[] }

export interface Library {
  name: string
  downloads?: { artifact?: Artifact; classifiers?: Record<string, Artifact> }
  natives?: Record<string, string>
  rules?: Rule[]
  extract?: { exclude: string[] }
}

export interface AssetIndexRef {
  id: string
  sha1: string
  size: number
  totalSize: number
  url: string
}

export interface VersionJson {
  id: string
  type: VersionType
  mainClass: string
  assets?: string
  assetIndex: AssetIndexRef
  downloads: { client: Artifact; client_mappings?: Artifact; server?: Artifact }
  libraries: Library[]
  javaVersion?: { component: string; majorVersion: number }
  arguments?: { game: ArgEntry[]; jvm: ArgEntry[] }
  minecraftArguments?: string
  minimumLauncherVersion?: number
  inheritsFrom?: string
  jar?: string
  releaseTime?: string
  time?: string
}

/** 合并 inheritsFrom 链之后的有效版本 */
export interface ResolvedVersion {
  id: string
  type: VersionType
  mainClass: string
  assets: string
  assetIndex: AssetIndexRef
  libraries: Library[]
  arguments?: { game: ArgEntry[]; jvm: ArgEntry[] }
  minecraftArguments?: string
  javaMajor: number
  clientJarId: string
  client: Artifact
}

/* ------------------------------------------------------------------ 实例 */

export type LoaderKind = 'vanilla' | 'fabric' | 'quilt' | 'forge' | 'neoforge'

export interface InstanceConfig {
  id: string
  name: string
  slug: string
  createdAt: string
  lastPlayedAt?: string
  gameVersion: string
  versionId: string
  loader: { kind: LoaderKind; version?: string }
  java: { mode: 'auto' | 'custom'; path?: string; majorVersion?: number }
  memory: { minMb: number; maxMb: number }
  window: { width: number; height: number; fullscreen: boolean }
  jvmArgs: string[]
  gameArgs: string[]
  source?: { provider: 'modrinth' | 'curseforge' | 'local'; projectId?: string; versionId?: string; title?: string }
  verifyOnLaunch: boolean
  /** 整合包还在导入时的临时状态；装完就删掉 */
  importState?: ImportState
  /** 首页 hero 卡背景；没有就用渐变 */
  background?: InstanceBackground
}

/** 首页卡片背景。图片统一转成 1920 宽的 jpg 存在实例目录里 */
export interface InstanceBackground {
  /** upload = 自己传的；world = 存档 icon.png；screenshot = 游戏截图 */
  source: 'upload' | 'world' | 'screenshot'
  /** 相对实例目录的文件名 */
  file: string
  /** 保存时间，渲染层拿它做 cache-bust */
  updatedAt: string
}

/** 导入阶段。顺序就是界面上那条轨道的顺序 */
export type ImportStage = 'parse' | 'version' | 'loader' | 'mods' | 'overrides' | 'done'

/**
 * 导入进度事件（主进程 → 渲染层）。
 * 和左侧任务栏的 TaskProgress 分开：那个描述「下载量」，这个描述「导入到哪一步」。
 */
export interface ImportProgress {
  instanceId: string
  stage: ImportStage
  label: string
  /** 阶段内部 0-1 */
  stagePercent: number
  /** 整体 0-1，已经按阶段权重折算过 */
  percent: number
  done: number
  total: number
  error?: string
  cancelled?: boolean
}

/** 落盘的导入状态：让「导入中」的实例在切页面、重启之后依然能显示出来 */
export interface ImportState {
  status: 'importing' | 'failed' | 'interrupted'
  stage: ImportStage
  stagePercent: number
  percent: number
  label: string
  done: number
  total: number
  startedAt: string
  /** 重试要知道原包在哪 */
  zipPath?: string
  error?: string
}

/* ------------------------------------------------------------ 整合包导入 */

export type PackFormat = 'curseforge' | 'modrinth' | 'raw'

export interface PackLoader {
  kind: 'fabric' | 'forge' | 'neoforge'
  version: string
}

/** 本地整合包解析结果（只描述，不落盘） */
export interface PackManifest {
  format: PackFormat
  zipPath: string
  name: string
  version?: string
  minecraft?: string
  loader?: PackLoader
  /** 作者建议的内存（MB） */
  recommendedRamMb?: number
  /** 需要联网下载的模组 */
  files: { projectId: number; fileId: number }[]
  /** zip 内要铺到游戏目录的目录前缀（含结尾斜杠） */
  overridePrefixes: string[]
  /** 包里自带、不用下载的 mod 数量 */
  bundledMods: number
}

export interface ModCandidate {
  projectId: string
  slug: string
  title: string
  versionNumber: string
  fileName: string
  downloadUrl: string
  size: number
  sha1?: string
  /**
   * 候选版本并不满足模组写死的版本范围（比如模组要 >=9.9.9 但 Modrinth 最高只到 0.116.x）。
   * 这时不能直接装——装上去照样崩，必须让用户看见并自己决定。
   */
  rangeMismatch?: boolean
}

export interface MissingDependency {
  id: string
  /** 哪些已装模组要它 */
  requiredBy: string[]
  /** Fabric 版本范围，通常就是 * */
  versionRange: string
  /** 同一个依赖被多个模组要求时，各自定义的范围（都满足才算能装） */
  allRanges?: string[]
  /** Modrinth 上匹配当前游戏版本 + Fabric 的最新版；没找到则为空 */
  candidate?: ModCandidate
}

export interface ModDependencyReport {
  scanned: number
  missing: MissingDependency[]
}

export interface ModFile {
  fileName: string
  size: number
  enabled: boolean
  projectId?: string
}

/** 资源包 / 光影包文件（shaderpacks / resourcepacks 目录里的条目） */
export interface ResPackFile {
  fileName: string
  size: number
  enabled: boolean
}

/** 光影支持自动安装的结果 */
export interface ShaderInstallResult {
  installed: string[]
  failed: { slug: string; message: string }[]
  /** mods 目录里确实有 Iris / OptiFine 了 —— 光影菜单才会在游戏里出现 */
  ready: boolean
}

export interface InstalledVersionInfo {
  id: string
  installed: boolean
  complete: boolean
  /** 自带 client jar 的才是"基础版本"；Fabric/Forge 这类 inheritsFrom 的 profile 没有 jar */
  hasJar: boolean
  instanceCount: number
  javaMajor: number
}

/* ------------------------------------------------------------------ 内网穿透 */

export type TunnelProviderId = 'sakura' | 'mefrp' | 'hayfrp'

/**
 * 隧道阶段。渲染层据此驱动状态变换动画。
 * 定义见 core/tunnelState.ts。
 */
export type TunnelPhase =
  | 'idle'
  | 'starting'
  | 'connecting'
  | 'online'
  | 'ready'
  | 'offline'
  | 'error'
  | 'stopping'

export interface TunnelSummary {
  id: string
  name: string
  online: boolean
  remoteAddr?: string
  localPort?: number
  type?: string
  node?: string
}

/**
 * 平台账号概况：剩余流量 / 带宽 / 隧道数。
 *
 * 三家的字段口径完全不同（樱花给 [今日消耗, 总剩余] 字节，幻缘给剩余 MiB + Kbps 带宽，
 * HayFrp 给剩余 MB 字符串），这里统一归一成 MB / Mbps 再交给 UI。
 * 拿不到的字段就留空，不做假数据。
 */
export interface TunnelAccountInfo {
  provider: TunnelProviderId
  /** 用户组 / 套餐名 */
  group?: string
  /** 剩余流量（MB） */
  trafficRemainingMb?: number
  /** 今日已用流量（MB） */
  trafficTodayMb?: number
  /** 带宽（Mbps），单值（樱花的「限速」） */
  bandwidthMbps?: number
  /** 上行带宽（Mbps） */
  bandwidthInMbps?: number
  /** 下行带宽（Mbps） */
  bandwidthOutMbps?: number
  /** 已用隧道数 */
  tunnelsUsed?: number
  /** 隧道数上限 */
  tunnelsLimit?: number
  /** 账号状态异常（冻结 / 超流量 / 未实名）时的提示 */
  warn?: string
}

export interface TunnelStatus {
  running: boolean
  pid: number | null
  /** 本地端口是否在线（有人在监听） */
  portOpen: boolean
  /** 当前隧道所处阶段，驱动 UI 状态变换动画 */
  phase: TunnelPhase
  /** 本地端口号 */
  localPort?: number
  /** 公网连接地址 */
  remoteAddr?: string
  /** 最近一次端口探测耗时 */
  latencyMs?: number
  /** 失败时从 frpc 日志里挑出的一行错误，UI 直接展示给用户 */
  lastError?: string
  log: string[]
}

export interface TunnelLaunchResult {
  provider: TunnelProviderId
  tunnelId: string
  pid: number
}

/* ------------------------------------------------------------------ 账号 */

export interface Account {
  id: string
  name: string
  type: 'microsoft' | 'offline'
  skinModel?: 'classic' | 'slim'
  /** 自定义皮肤文件名（相对于 skins 目录）；为空则用内置 Steve / Alex */
  skinFile?: string
  createdAt: string
}

/** 主进程内部使用，绝不通过 IPC 传出 */
export interface StoredAccount extends Account {
  tokens?: { accessToken: string; refreshToken?: string; expiresAt: number }
}

/* ------------------------------------------------------------------ 配置 */

export type ThemeMode = 'dark' | 'light' | 'system'
export type MirrorMode = 'auto' | 'official' | 'bmclapi'
export type UiDensity = 'comfortable' | 'compact'
export type AccentKey = 'green' | 'blue' | 'violet' | 'amber' | 'rose'

export interface JavaRuntimeInfo {
  path: string
  version: string
  major: number
  vendor?: string
  managed?: boolean
}

export interface AppConfig {
  theme: ThemeMode
  /** 界面密度：紧凑会压缩行高与内边距，小屏幕上能多塞两行 */
  density: UiDensity
  /** 强调色预设，只换主色，不动背景层级 */
  accent: AccentKey
  javaRuntimes: JavaRuntimeInfo[]
  javaPreference: string // 'auto' 或某个 java 可执行文件的绝对路径
  /** 启动前校验一次文件完整性（本地库/资源），慢但能挡住"进游戏崩溃" */
  verifyOnLaunch: boolean
  defaultMemory: { minMb: number; maxMb: number }
  defaultWindow: { width: number; height: number; fullscreen: boolean }
  mirror: MirrorMode
  concurrency: number
  /** 单个文件换源重试次数 */
  downloadRetries: number
  /** 单文件超时（秒） */
  downloadTimeoutSec: number
  lastInstanceId?: string
  activeAccountId?: string
  /** 内网穿透访问令牌（按平台分别保存，仅存本地） */
  tunnelTokens?: Partial<Record<TunnelProviderId, string>>
  /** 崩溃上报，默认关闭；endpoint 留空 = 只本地落盘不外发 */
  crashReport?: {
    enabled: boolean
    endpoint: string
  }
}

/* --------------------------------------------------------------- 系统信息 */

export interface StorageSlice {
  key: string
  label: string
  bytes: number
  files: number
}

export interface StorageUsage {
  total: number
  slices: StorageSlice[]
  scannedAt: number
}

export interface SystemInfo {
  appVersion: string
  electron: string
  chrome: string
  node: string
  platform: string
  arch: string
  osVersion: string
  totalMemMb: number
  cpuModel: string
  cpuCores: number
}

/* ------------------------------------------------------------- 在线更新 */

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
  hasUpdate: boolean
  currentVersion: string
  latest: UpdateInfo | null
}

export interface UpdateDownloadResult {
  hasUpdate: boolean
  latest: UpdateInfo | null
  downloaded: boolean
}

export interface UpdateProgress {
  phase: 'downloading' | 'downloaded' | 'installing' | 'error'
  doneBytes: number
  totalBytes: number
  message?: string
}

/* ------------------------------------------------------------------ 任务 */

export type TaskStage =
  | 'queued'
  | 'resolve'
  | 'client'
  | 'libraries'
  | 'natives'
  | 'assets'
  | 'java'
  | 'loader'
  | 'mods'
  | 'launch'
  | 'done'

export interface TaskProgress {
  taskId: string
  title: string
  stage: TaskStage
  label: string
  doneFiles: number
  totalFiles: number
  doneBytes: number
  totalBytes: number
  speedBps: number
  /** 本阶段已耗时（毫秒），用于估算剩余时间 */
  elapsedMs?: number
  /** 该任务从第几个阶段开始算（用于「3 / 5 依赖库」这类展示） */
  stageIndex?: number
  stageCount?: number
  error?: { code: string; message: string }
}

export interface ModpackSummary {
  projectId: string
  slug: string
  title: string
  description: string
  iconUrl?: string
  downloads: number
  gameVersions: string[]
  loaders: string[]
  provider: 'modrinth'
}

/* ------------------------------------------------------------------ IPC */

export type Result<T> = { ok: true; data: T } | { ok: false; code: string; message: string }

export interface LaunchOptions {
  instanceId: string
}

export interface NovaApi {
  config: {
    get(): Promise<Result<AppConfig>>
    patch(patch: Partial<AppConfig>): Promise<Result<AppConfig>>
    reset(): Promise<Result<AppConfig>>
  }
  versions: {
    list(force?: boolean): Promise<Result<VersionManifest>>
    installed(): Promise<Result<InstalledVersionInfo[]>>
    install(versionId: string): Promise<Result<null>>
    installFabric(gameVersion: string, loaderVersion?: string): Promise<Result<{ versionId: string; loaderVersion: string }>>
    listForge(family: 'forge' | 'neoforge', mcVersion: string): Promise<Result<{ id: string; mcVersion: string; build: string; prerelease: boolean }[]>>
    installForge(family: 'forge' | 'neoforge', loaderVersion: string): Promise<Result<{ versionId: string }>>
    remove(versionId: string): Promise<Result<null>>
  }
  instances: {
    list(): Promise<Result<InstanceConfig[]>>
    create(input: Partial<InstanceConfig> & { name: string; gameVersion: string }): Promise<Result<InstanceConfig>>
    update(id: string, patch: Partial<InstanceConfig>): Promise<Result<InstanceConfig>>
    remove(id: string): Promise<Result<null>>
    mods(id: string): Promise<Result<ModFile[]>>
    toggleMod(id: string, fileName: string, enabled: boolean): Promise<Result<null>>
    packages(id: string, kind: 'shader' | 'resource'): Promise<Result<ResPackFile[]>>
    togglePackage(id: string, kind: 'shader' | 'resource', fileName: string, enabled: boolean): Promise<Result<null>>
    /** 打开光影 / 材质包目录（不存在会自动创建），返回目录路径 */
    openPackDir(id: string, kind: 'shader' | 'resource'): Promise<Result<string>>
    checkDeps(id: string): Promise<Result<ModDependencyReport>>
    fixDeps(id: string): Promise<Result<{ installed: string[]; failed: { id: string; message: string }[] }>>
    /** 选一张本地图片当首页卡片背景；用户取消返回 null */
    pickBackground(id: string): Promise<Result<InstanceConfig | null>>
    /** 自动从存档 icon.png / 最新游戏截图取图；找不到返回 null */
    autoBackground(id: string): Promise<Result<{ instance: InstanceConfig; source: 'world' | 'screenshot' } | null>>
    /** 恢复默认渐变 */
    clearBackground(id: string): Promise<Result<InstanceConfig>>
    /** 读取背景图的 data URL；没有则返回 null */
    background(id: string): Promise<Result<string | null>>
  }
  launch: {
    start(instanceId: string): Promise<Result<{ pid?: number }>>
    kill(): Promise<Result<null>>
    running(): Promise<Result<string | null>>
  }
  auth: {
    list(): Promise<Result<Account[]>>
    addOffline(name: string, skinModel?: 'classic' | 'slim'): Promise<Result<Account>>
    remove(id: string): Promise<Result<null>>
    activate(id: string): Promise<Result<Account>>
    /** 选文件并应用自定义皮肤；用户取消返回 null */
    setSkin(id: string): Promise<Result<Account | null>>
    /** 清除自定义皮肤，回退内置 Steve / Alex */
    clearSkin(id: string): Promise<Result<Account>>
    /** 读取自定义皮肤的 data URL；没有则返回 null */
    skinDataUrl(id: string): Promise<Result<string | null>>
  }
  java: {
    detect(): Promise<Result<JavaRuntimeInfo[]>>
    provision(major: number): Promise<Result<string>>
  }
  modpack: {
    search(query: string, gameVersion?: string): Promise<Result<ModpackSummary[]>>
    install(projectId: string, instanceName?: string): Promise<Result<InstanceConfig>>
    /** 选一个本地整合包 zip，只解析清单给界面看；用户取消返回 null */
    pickZip(): Promise<Result<PackManifest | null>>
    /** 导入本地整合包（zip 路径来自 pickZip）。建好「导入中」的实例就返回，下载在后台跑 */
    importZip(zipPath: string, instanceName?: string): Promise<Result<InstanceConfig>>
    /** 中止导入并删掉半成品实例 */
    cancelImport(instanceId: string): Promise<Result<null>>
    /** 导入失败/中断后用原来的 zip 重来一次 */
    retryImport(instanceId: string): Promise<Result<InstanceConfig>>
  }
  shader: {
    supports(id: string): Promise<Result<boolean>>
    plan(id: string): Promise<Result<string[]>>
    /** 这个实例的 mods 里是否已有 Iris / OptiFine */
    status(id: string): Promise<Result<{ ready: boolean; found: string[] }>>
    install(id: string): Promise<Result<ShaderInstallResult>>
    /** 手动选本地 jar 安装（OptiFine 官网不可达时用） */
    installLocal(id: string): Promise<Result<{ canceled: boolean; fileName: string }>>
  }
  tunnel: {
    list(provider: TunnelProviderId, token: string): Promise<Result<TunnelSummary[]>>
    account(provider: TunnelProviderId, token: string): Promise<Result<TunnelAccountInfo>>
    start(provider: TunnelProviderId, token: string, tunnel: TunnelSummary): Promise<Result<TunnelLaunchResult>>
    stop(): Promise<Result<null>>
    status(): Promise<Result<TunnelStatus>>
  }
  system: {
    openPath(target: string): Promise<Result<null>>
    paths(): Promise<
      Result<{ root: string; instances: string; portable: boolean; fallbackReason?: string }>
    >
    pickJava(): Promise<Result<string | null>>
    logs(): Promise<Result<string[]>>
    storage(force?: boolean): Promise<Result<StorageUsage>>
    info(): Promise<Result<SystemInfo>>
    clearLogs(): Promise<Result<number>>
  }
  update: {
    check(): Promise<Result<UpdateCheckResult>>
    download(): Promise<Result<UpdateDownloadResult>>
    install(): Promise<Result<{ installed: boolean }>>
    openReleases(): Promise<Result<null>>
    openSource(): Promise<Result<null>>
    cancel(): Promise<Result<null>>
  }
  events: {
    onProgress(cb: (p: TaskProgress) => void): () => void
    onLog(cb: (line: string) => void): () => void
    onExit(cb: (p: { code: number | null; crashLog?: string }) => void): () => void
    onTheme(cb: (mode: ThemeMode) => void): () => void
    /** 整合包导入进度（导入面板 + 导入中的实例卡共用） */
    onImport(cb: (p: ImportProgress) => void): () => void
    /** 在线更新下载进度 */
    onUpdate(cb: (p: UpdateProgress) => void): () => void
  }
}
