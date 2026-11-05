import { ipcMain, shell, dialog, BrowserWindow, nativeTheme, app } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { AppContext } from './context'
import { toResultError, fail, wrap, NovaError, ERROR_TEXT } from '../core/errors'
import type {
  AppConfig,
  ImportProgress,
  ImportStage,
  InstanceConfig,
  JavaRuntimeInfo,
  PackManifest,
  Result,
  TaskProgress,
  TaskStage
} from '../core/types'
import { pickJava } from '../core/java'
import { provisionJava } from '../core/javaProvision'
import { buildLaunchCommand } from '../core/launch'
import { recordCrash } from '../core/crashReport'
import type { TunnelProviderId, TunnelSummary } from '../core/types'
import { saveBackground, findWorldImage } from './background'

/** 导入各阶段在总进度里的权重，加起来正好 1 */
const IMPORT_WEIGHTS: Record<Exclude<ImportStage, 'done'>, number> = {
  parse: 0.03,
  version: 0.34,
  loader: 0.13,
  mods: 0.42,
  overrides: 0.08
}

const IMPORT_ORDER: Exclude<ImportStage, 'done'>[] = ['parse', 'version', 'loader', 'mods', 'overrides']

interface ImportRun {
  cancelled: boolean
  zipPath: string
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function ok<T>(data: T): Result<T> {
  return { ok: true, data }
}

async function guard<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return ok(await fn())
  } catch (e) {
    if (!(e instanceof NovaError)) console.error('[ipc]', e)
    return toResultError(e) as Result<T>
  }
}

/** 配置落到运行时对象上——只改 config.json 而不改内存里的实例，等于要用户重启才生效 */
function applyConfig(ctx: AppContext, patch: Partial<AppConfig>): void {
  if (patch.mirror) ctx.mirror.mode = patch.mirror
  if (patch.concurrency) ctx.pool.setConcurrency(patch.concurrency)
  if (patch.downloadRetries) ctx.pool.setRetries(patch.downloadRetries)
  if (patch.downloadTimeoutSec) ctx.pool.setTimeoutMs(patch.downloadTimeoutSec * 1000)
  if (patch.theme) nativeTheme.themeSource = patch.theme === 'system' ? 'system' : patch.theme
}

export function registerIpc(ctx: AppContext): void {
  const broadcast = (channel: string, payload: unknown) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  }

  const progress = (p: TaskProgress) => broadcast('task:progress', p)

  /* ---------------------------------------------------------- 配置 */

  ipcMain.handle('config:get', () => guard(() => ctx.config.load()))

  ipcMain.handle('config:patch', (_e, patch: Partial<AppConfig>) =>
    guard(async () => {
      const next = await ctx.config.patch(patch)
      applyConfig(ctx, patch)
      return next
    })
  )

  ipcMain.handle('config:reset', () =>
    guard(async () => {
      const next = await ctx.config.reset()
      applyConfig(ctx, next)
      return next
    })
  )

  /* ---------------------------------------------------------- 版本 */

  ipcMain.handle('versions:list', (_e, force?: boolean) => guard(() => ctx.manifest.load(Boolean(force))))

  ipcMain.handle('versions:installed', () =>
    guard(async () => {
      const ids = await ctx.versions.listInstalled()
      const instances = await ctx.instances.list()
      const out = []
      for (const id of ids) {
        const json = await ctx.versions.getJson(id).catch(() => null)
        out.push({
          id,
          installed: true,
          complete: await ctx.versions.isComplete(id),
          // 「基础版本」= 没有 inheritsFrom。Forge/Fabric 这类继承型 profile
          // 也有自己的 jar（patched jar），但不该出现在「游戏版本」下拉里。
          hasJar:
            !json?.inheritsFrom &&
            (await fs
              .access(ctx.paths.versionJar(id))
              .then(() => true)
              .catch(() => false)),
          instanceCount: instances.filter((i) => i.versionId === id || i.gameVersion === id).length,
          javaMajor: json?.javaVersion?.majorVersion ?? 8
        })
      }
      return out.sort((a, b) => a.id.localeCompare(b.id))
    })
  )

  ipcMain.handle('versions:install', (_e, versionId: string) =>
    guard(async () => {
      await installVersion(ctx, versionId, progress)
      return null
    })
  )

  ipcMain.handle('versions:remove', (_e, versionId: string) =>
    guard(async () => {
      await ctx.versions.remove(versionId)
      return null
    })
  )

  ipcMain.handle('versions:installFabric', (_e, gameVersion: string, loaderVersion?: string) =>
    guard(async () => {
      const res = await ctx.versions.installFabric(gameVersion, loaderVersion)
      await installVersion(ctx, res.versionId, progress)
      return res
    })
  )

  /** Forge / NeoForge 的可用版本列表（按 MC 版本过滤） */
  ipcMain.handle('versions:listForge', (_e, family: 'forge' | 'neoforge', mcVersion: string) =>
    guard(() => ctx.forge.listLoaders(family, mcVersion))
  )

  /** 安装 Forge / NeoForge */
  ipcMain.handle('versions:installForge', (_e, family: 'forge' | 'neoforge', loaderVersion: string) =>
    guard(async () => {
      // 需要一个能跑 processor 的 Java（Forge/NeoForge 都要求 17+）
      const cfg = await ctx.config.load()
      const java = pickJava(await ctx.java.detect(), 17, cfg.javaPreference)
      const javaPath =
        java?.path ?? (await ensureJava(ctx, 17, progress)).path

      const taskId = crypto.randomUUID()
      const title = `安装 ${family === 'forge' ? 'Forge' : 'NeoForge'} ${loaderVersion}`
      const res = await ctx.forge.install(family, loaderVersion, {
        javaPath,
        onProgress: (label, done, total) => {
          progress({
            taskId,
            title,
            stage: 'mods',
            label,
            doneFiles: done,
            totalFiles: total,
            doneBytes: 0,
            totalBytes: 0,
            speedBps: 0
          })
        }
      })
      // 安装完 Forge 后，其依赖库也要补全（版本 JSON 里带的 libraries）
      await installVersion(ctx, res.versionId, progress)
      progress({
        taskId,
        title,
        stage: 'done',
        label: '已安装',
        doneFiles: 1,
        totalFiles: 1,
        doneBytes: 0,
        totalBytes: 0,
        speedBps: 0
      })
      return res
    })
  )

  /* ---------------------------------------------------------- 实例 */

  ipcMain.handle('instances:list', () => guard(() => ctx.instances.list()))

  ipcMain.handle('instances:create', (_e, input: Partial<InstanceConfig> & { name: string; gameVersion: string }) =>
    guard(async () => {
      const cfg = await ctx.config.load()
      const inst = await ctx.instances.create({
        ...input,
        memory: input.memory ?? cfg.defaultMemory,
        window: input.window ?? cfg.defaultWindow,
        verifyOnLaunch: input.verifyOnLaunch ?? cfg.verifyOnLaunch
      })
      // 版本没装就先装，用户点一次"创建"就够
      await installVersion(ctx, inst.versionId, progress)
      return inst
    })
  )

  ipcMain.handle('instances:update', (_e, id: string, patch: Partial<InstanceConfig>) =>
    guard(() => ctx.instances.update(id, patch))
  )

  ipcMain.handle('instances:remove', (_e, id: string) =>
    guard(async () => {
      await ctx.instances.remove(id)
      return null
    })
  )

  ipcMain.handle('instances:mods', (_e, id: string) => guard(() => ctx.instances.mods(id)))

  ipcMain.handle('instances:toggleMod', (_e, id: string, fileName: string, enabled: boolean) =>
    guard(async () => {
      await ctx.instances.toggleMod(id, fileName, enabled)
      return null
    })
  )

  ipcMain.handle('instances:packages', (_e, id: string, kind: 'shader' | 'resource') =>
    guard(() => ctx.instances.packages(id, kind))
  )

  ipcMain.handle(
    'instances:togglePackage',
    (_e, id: string, kind: 'shader' | 'resource', fileName: string, enabled: boolean) =>
      guard(async () => {
        await ctx.instances.togglePackage(id, kind, fileName, enabled)
        return null
      })
  )

  /**
   * 打开光影 / 材质包目录。
   * 目录不存在就先建出来——很多实例还没进过游戏，这两个目录本来就不存在，
   * 直接 openPath 只会得到一句「系统找不到指定的路径」。
   */
  ipcMain.handle('instances:openPackDir', (_e, id: string, kind: 'shader' | 'resource') =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const dir = path.join(
        ctx.paths.instanceGameDir(inst.slug),
        kind === 'shader' ? 'shaderpacks' : 'resourcepacks'
      )
      await fs.mkdir(dir, { recursive: true })
      const error = await shell.openPath(dir)
      if (error) throw fail('E_OPEN_PATH', `打不开这个目录：${error}`)
      return dir
    })
  )

  /** 启动前的模组依赖自检：只读 jar，不联网（除非确实缺东西才去 Modrinth 找候选） */
  ipcMain.handle('instances:checkDeps', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      return ctx.modDeps.analyze(inst)
    })
  )

  ipcMain.handle('instances:fixDeps', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const report = await ctx.modDeps.analyze(inst, true)
      if (!report.missing.length) return { installed: [], failed: [] }

      const taskId = crypto.randomUUID()
      const title = '补齐前置模组'
      const res = await ctx.modDeps.installMissing(inst, report, (done, total, label) => {
        progress({
          taskId,
          title,
          stage: 'mods',
          label,
          doneFiles: done,
          totalFiles: total,
          doneBytes: 0,
          totalBytes: 0,
          speedBps: 0
        })
      })
      progress({
        taskId,
        title,
        stage: 'done',
        label: res.installed.length ? `已安装 ${res.installed.join('、')}` : '没有可自动安装的前置',
        doneFiles: 1,
        totalFiles: 1,
        doneBytes: 0,
        totalBytes: 0,
        speedBps: 0
      })
      ctx.modDeps.clearCache(inst.id)
      return res
    })
  )

  /* ---------------------------------------------------------- 光影支持 */

  ipcMain.handle('shader:supports', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      return ctx.shader.supports(inst)
    })
  )

  ipcMain.handle('shader:plan', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      return ctx.shader.planFor(inst)
    })
  )

  ipcMain.handle('shader:status', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      return ctx.shader.status(inst)
    })
  )

  /** 手动选择本地 OptiFine / Iris jar（官网连不上时的兜底） */
  ipcMain.handle('shader:installLocal', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const picked = await dialog.showOpenDialog({
        title: '选择下载好的 OptiFine / Iris jar',
        filters: [{ name: 'Java 模组', extensions: ['jar'] }],
        properties: ['openFile']
      })
      if (picked.canceled || !picked.filePaths[0]) {
        return { canceled: true as const, fileName: '' }
      }
      const r = await ctx.shader.installLocal(inst, picked.filePaths[0])
      return { canceled: false as const, fileName: r.fileName }
    })
  )

  ipcMain.handle('shader:install', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const taskId = crypto.randomUUID()
      const title = '安装光影支持'
      const res = await ctx.shader.install(inst, (label, done, total) => {
        progress({
          taskId,
          title,
          stage: 'mods',
          label,
          doneFiles: done,
          totalFiles: total,
          doneBytes: 0,
          totalBytes: 0,
          speedBps: 0
        })
      })
      progress({
        taskId,
        title,
        stage: 'done',
        label: res.installed.length ? `已安装 ${res.installed.join('、')}` : '没有可自动安装的组件',
        doneFiles: 1,
        totalFiles: 1,
        doneBytes: 0,
        totalBytes: 0,
        speedBps: 0
      })
      return res
    })
  )

  /* ---------------------------------------------------------- 内网穿透 */

  ipcMain.handle('tunnel:list', (_e, provider: TunnelProviderId, token: string) =>
    guard(async () => {
      // 先把凭据落盘，再去拉隧道。
      //
      // 之前只在 tunnel:start 里保存令牌，而用户在弹窗里点「保存并拉取」走的是
      // tunnel:list —— 令牌压根没存，于是切页回来又要求重新配置。
      // 现在改成先存后拉：即便拉取因网络问题失败，凭据也已经保存下来了。
      const cfg = await ctx.config.load()
      if ((cfg.tunnelTokens?.[provider] ?? '') !== token) {
        await ctx.config.patch({
          tunnelTokens: { ...(cfg.tunnelTokens ?? {}), [provider]: token }
        })
      }
      return ctx.tunnel.listTunnels(provider, token)
    })
  )

  ipcMain.handle('tunnel:account', (_e, provider: TunnelProviderId, token: string) =>
    guard(() => ctx.tunnel.accountInfo(provider, token))
  )

  ipcMain.handle(
    'tunnel:start',
    (_e, provider: TunnelProviderId, token: string, tunnel: TunnelSummary) =>
      guard(async () => {
        // 记住令牌，下次进来不用重填
        const cfg = await ctx.config.load()
        await ctx.config.patch({
          tunnelTokens: { ...(cfg.tunnelTokens ?? {}), [provider]: token }
        })
        return ctx.tunnel.start(provider, token, tunnel)
      })
  )

  ipcMain.handle('tunnel:stop', () =>
    guard(async () => {
      ctx.tunnel.stop()
      return null
    })
  )

  ipcMain.handle('tunnel:status', () => guard(() => ctx.tunnel.status()))

  /* ---------------------------------------------------------- 启动 */

  ipcMain.handle('launch:start', (_e, instanceId: string) =>
    guard(async () => {
      const instance = await ctx.instances.get(instanceId)

      // 还在导入的实例文件不全，启动只会崩在模组加载阶段
      if (instance.importState) {
        throw fail(
          'E_IMPORT_RUNNING',
          instance.importState.status === 'importing'
            ? '这个实例还在导入中，等装完再启动'
            : '这个实例上次导入没有完成，先在实例页重试或删除'
        )
      }

      // 缺前置模组时 Fabric 会在游戏进程里崩，启动器只能看到非 0 退出码。
      // 在这里提前拦住，把要装什么说清楚。
      // 这一步放在账号检查之前：用户刚拖进来的模组缺前置，
      // 告诉他"先补齐前置"比告诉他"先去建账号"更贴近当下要做的事。
      const depReport = await ctx.modDeps.analyze(instance)
      if (depReport.missing.length) {
        const names = depReport.missing.map((m) => m.id).join('、')
        throw fail(
          'E_MOD_DEPS_MISSING',
          `缺少前置模组：${names}。打开「模组」可以一键补齐`
        )
      }

      const account = await ctx.accounts.active()
      if (!account) throw fail('E_ACCOUNT_MISSING', '请先在「账号」里创建一个账号')

      const resolved = await ctx.versions.resolve(instance.versionId)
      // 本机没有匹配的 Java 就自动补一个受管运行时，不让玩家自己去找 JDK
      const java = await ensureJava(ctx, resolved.javaMajor, progress)

      // 首次启动前自动补全缺失文件
      if (!(await ctx.versions.isComplete(instance.versionId))) {
        await installVersion(ctx, instance.versionId, progress)
      } else if (instance.verifyOnLaunch) {
        // 只校验 jar 与依赖库（资源对象几千个，启动前全量比对太慢），
        // 有损坏就重下，下载池会跳过完好的文件
        const { dirty } = await ctx.installer.verify(instance.versionId, { assets: false })
        if (dirty.length) await installVersion(ctx, instance.versionId, progress)
      }

      // 现代版本即使没有 legacy natives 也要保证目录存在
      await fs.mkdir(ctx.paths.nativesDir(instance.slug), { recursive: true })

      const cmd = buildLaunchCommand({
        resolved,
        instance,
        account,
        java,
        paths: ctx.paths,
        platform: ctx.platform,
        launcher: { name: 'NovaMC', version: '0.1.0' }
      })

      progress({
        taskId: crypto.randomUUID(),
        title: `启动 ${instance.name}`,
        stage: 'launch',
        label: `${java.path}`,
        doneFiles: 0,
        totalFiles: 0,
        doneBytes: 0,
        totalBytes: 0,
        speedBps: 0
      })

      const result = ctx.launcher.start(cmd, instance.id, {
        onLog: (line) => broadcast('game:log', line),
        onExit: async ({ code, signal, crashLog }) => {
          broadcast('game:exit', { code, signal, crashLog })
          if (code === 0) progress({ ...emptyTask(instance.name), stage: 'done', label: '已退出' })
          // 崩溃上报（默认关闭，未启用时 recordCrash 直接返回 null）
          if (code !== 0) {
            void (async () => {
              try {
                const cfg = await ctx.config.load()
                await recordCrash({
                  cfg,
                  dataDir: ctx.paths.root,
                  http: ctx.http,
                  appVersion: app.getVersion(),
                  report: {
                    instance: instance.name,
                    gameVersion: instance.gameVersion ?? '',
                    exitCode: code,
                    signal,
                    summary: [crashLog ?? '', ...ctx.launcher.lastLogLines(60)].join('\n')
                  }
                })
              } catch {
                /* 上报永远不影响主流程 */
              }
            })()
          }
        }
      })

      await ctx.instances.touch(instance.id)
      return { pid: result.pid }
    })
  )

  ipcMain.handle('launch:kill', () =>
    guard(async () => {
      ctx.launcher.stop()
      return null
    })
  )

  ipcMain.handle('launch:running', () => guard(async () => ctx.launcher.runningInstanceId))

  /* ---------------------------------------------------------- 账号 */

  ipcMain.handle('auth:list', () => guard(() => ctx.accounts.list()))
  ipcMain.handle(
    'auth:addOffline',
    (_e, name: string, skinModel: 'classic' | 'slim' = 'classic') =>
      guard(() => ctx.accounts.addOffline(name, skinModel))
  )
  ipcMain.handle('auth:remove', (_e, id: string) =>
    guard(async () => {
      await ctx.accounts.remove(id)
      return null
    })
  )
  ipcMain.handle('auth:activate', (_e, id: string) => guard(() => ctx.accounts.activate(id)))

  /**
   * 选择并应用账号皮肤。
   * 弹文件框让用户挑一张 64×64 的 PNG，然后复制进 NovaMC 的 skins 目录。
   */
  ipcMain.handle('auth:setSkin', (_e, id: string) =>
    guard(async () => {
      const res = await dialog.showOpenDialog({
        title: '选择皮肤文件（64×64 PNG）',
        properties: ['openFile'],
        filters: [{ name: 'Minecraft 皮肤', extensions: ['png'] }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      return ctx.accounts.setSkin(id, res.filePaths[0])
    })
  )

  ipcMain.handle('auth:clearSkin', (_e, id: string) => guard(() => ctx.accounts.clearSkin(id)))

  /** 读取账号皮肤（data URL），没有自定义皮肤时返回 null，由前端用内置 Steve/Alex */
  ipcMain.handle('auth:skinDataUrl', (_e, id: string) => guard(() => ctx.accounts.skinDataUrl(id)))

  /* ---------------------------------------------------------- Java */

  ipcMain.handle('java:detect', () =>
    guard(async () => {
      const cfg = await ctx.config.load()
      const list = await ctx.java.detect()
      await ctx.config.patch({ javaRuntimes: list })
      if (cfg.javaPreference !== 'auto' && !list.some((j) => j.path === cfg.javaPreference)) {
        await ctx.config.patch({ javaPreference: 'auto' })
      }
      return list
    })
  )

  ipcMain.handle('java:provision', (_e, major: number) =>
    guard(async () => {
      const taskId = crypto.randomUUID()
      const javaPath = await provisionJava(
        major,
        ctx.paths,
        ctx.pool,
        ctx.http,
        ctx.platform,
        ctx.mirror.mode,
        (p) => {
          progress({
            taskId,
            title: `安装 Java ${major}`,
            stage: 'java',
            label: p.label,
            doneFiles: p.done,
            totalFiles: p.total,
            doneBytes: p.doneBytes,
            totalBytes: p.totalBytes,
            speedBps: p.speedBps,
            elapsedMs: p.elapsedMs
          })
        }
      )
      const list = await ctx.java.detect()
      await ctx.config.patch({ javaRuntimes: list })
      return javaPath
    })
  )

  /* ---------------------------------------------------------- 整合包 */

  ipcMain.handle('modpack:search', (_e, query: string, gameVersion?: string) =>
    guard(() => ctx.modrinth.search(query, gameVersion))
  )

  ipcMain.handle('modpack:install', (_e, projectId: string, instanceName?: string) =>
    guard(async () => {
      const taskId = crypto.randomUUID()
      const inst = await ctx.modrinth.install(projectId, instanceName, (s) => {
        progress({
          taskId,
          title: '安装整合包',
          stage: 'mods',
          label: s.label,
          doneFiles: s.done,
          totalFiles: s.total,
          doneBytes: 0,
          totalBytes: 0,
          speedBps: 0
        })
      })
      await installVersion(ctx, inst.versionId, progress)
      return inst
    })
  )

  /* ------------------------------------------------------ 本地整合包导入 */

  /**
   * 导入是「先建实例，再后台跑」：
   * 玩家点完导入，实例页立刻多一张「导入中」的卡，进度挂在这张卡上；
   * 弹窗可以随时关掉，下载照跑。
   */
  const importRuns = new Map<string, ImportRun>()
  const emitImport = (p: ImportProgress): void => broadcast('import:progress', p)

  /** 阶段内进度 → 总进度（按权重累加） */
  function importOverall(stage: Exclude<ImportStage, 'done'>, stagePercent: number): number {
    const pct = Math.max(0, Math.min(1, stagePercent))
    let sum = 0
    for (const s of IMPORT_ORDER) {
      if (s === stage) return sum + IMPORT_WEIGHTS[s] * pct
      sum += IMPORT_WEIGHTS[s]
    }
    return sum
  }

  async function startImport(instance: InstanceConfig, pack: PackManifest, zipPath: string): Promise<void> {
    const mcVersion = pack.minecraft
    const loader = pack.loader
    if (!mcVersion || !loader) {
      throw fail('E_MODPACK_FORMAT', '这个整合包缺少游戏版本或加载器信息')
    }

    const run: ImportRun = { cancelled: false, zipPath }
    importRuns.set(instance.id, run)

    const taskId = crypto.randomUUID()
    const title = `导入 ${instance.name}`
    const gameDir = ctx.paths.instanceGameDir(instance.slug)
    const startedAt = instance.importState?.startedAt ?? new Date().toISOString()

    const check = (): void => {
      if (run.cancelled) throw fail('E_IMPORT_CANCELLED', '导入已取消')
    }

    // 落盘节流：卡片重启后要能接着显示，但没必要每 100ms 写一次 json
    let lastWrite = 0
    // 失败时要用「最后推进到的那一步」，而不是创建实例时的快照
    let last: Required<Pick<ImportProgress, 'stage' | 'stagePercent' | 'percent' | 'done' | 'total'>> = {
      stage: 'parse',
      stagePercent: 0,
      percent: 0,
      done: 0,
      total: pack.files.length
    }
    const push = (
      stage: Exclude<ImportStage, 'done'>,
      label: string,
      stagePercent: number,
      done = 0,
      total = 0
    ): void => {
      const percent = importOverall(stage, stagePercent)
      last = { stage, stagePercent: Math.max(0, Math.min(1, stagePercent)), percent, done, total }
      emitImport({ instanceId: instance.id, stage, label, stagePercent, percent, done, total })

      const now = Date.now()
      if (now - lastWrite < 900 && stagePercent < 1) return
      lastWrite = now
      void ctx.instances
        .setImportState(instance.id, {
          status: 'importing',
          stage,
          stagePercent: Math.max(0, Math.min(1, stagePercent)),
          percent,
          label,
          done,
          total,
          startedAt,
          zipPath
        })
        .catch(() => undefined)
    }

    // 侧边栏任务栏共用一条任务，避免「安装 1.20.1 / 安装 fabric-loader」来回跳
    const sidebar = (
      stage: TaskStage,
      label: string,
      stats?: { doneFiles: number; totalFiles: number; doneBytes: number; totalBytes: number; speedBps: number; elapsedMs?: number },
      index = 1
    ): void => {
      progress({
        taskId,
        title,
        stage,
        label,
        doneFiles: stats?.doneFiles ?? 0,
        totalFiles: stats?.totalFiles ?? 0,
        doneBytes: stats?.doneBytes ?? 0,
        totalBytes: stats?.totalBytes ?? 0,
        speedBps: stats?.speedBps ?? 0,
        elapsedMs: stats?.elapsedMs,
        stageIndex: index,
        stageCount: IMPORT_ORDER.length
      })
    }

    /** installVersion 自己会发一条任务，这里改写成同一条导入任务，同时喂给导入面板 */
    const fromVersion = (p: TaskProgress, stage: Exclude<ImportStage, 'done'>, index: number): void => {
      sidebar(p.stage, p.label, p)
      const sp = p.totalBytes > 0 ? p.doneBytes / p.totalBytes : p.totalFiles > 0 ? p.doneFiles / p.totalFiles : 0
      push(stage, p.label, sp, p.doneFiles, p.totalFiles)
      void index
    }

    try {
      // 0) 清单已经读过了，这一步只是把轨道点亮，让人马上看到「在动」
      push('parse', `读取 ${pack.files.length} 个模组的清单`, 1, 1, 1)
      sidebar('resolve', '解析整合包清单', undefined, 1)
      check()
      await sleep(140)

      // 1) 原版：没装过就先下
      if (!(await ctx.versions.isComplete(mcVersion))) {
        push('version', `准备安装 Minecraft ${mcVersion}`, 0, 0, 0)
        await installVersion(ctx, mcVersion, (p) => fromVersion(p, 'version', 2))
      } else {
        push('version', `Minecraft ${mcVersion} 已安装`, 1, 1, 1)
      }
      check()

      // 2) 加载器
      let versionId = mcVersion
      if (loader.kind === 'fabric') {
        push('loader', `安装 Fabric ${loader.version}`, 0.05, 0, 0)
        const res = await ctx.versions.installFabric(mcVersion, loader.version)
        versionId = res.versionId
        await installVersion(ctx, versionId, (p) => fromVersion(p, 'loader', 3))
      } else {
        push('loader', `准备安装 ${loader.kind}`, 0.05, 0, 0)
        const cfg = await ctx.config.load()
        const java = pickJava(await ctx.java.detect(), 17, cfg.javaPreference)
        const javaPath =
          java?.path ??
          (await ensureJava(ctx, 17, (p) => fromVersion(p, 'loader', 3))).path
        const res = await ctx.forge.install(loader.kind, loader.version, {
          javaPath,
          onProgress: (label, done, total) => {
            push('loader', label, total > 0 ? done / total : 0.3, done, total)
            sidebar('loader', label, { doneFiles: done, totalFiles: total, doneBytes: 0, totalBytes: 0, speedBps: 0 }, 3)
          }
        })
        versionId = res.versionId
        await installVersion(ctx, versionId, (p) => fromVersion(p, 'loader', 3))
      }
      check()

      // 加载器装完才知道最终 versionId，这里补回去
      if (versionId !== instance.versionId) {
        await ctx.instances.update(instance.id, { versionId })
      }
      push('loader', '模组加载器已就绪', 1, 1, 1)

      // 3) 模组
      push('mods', `下载 ${pack.files.length} 个模组`, 0, 0, pack.files.length)
      const dl = await ctx.packs.downloadMods(
        pack,
        gameDir,
        (s) => {
          push('mods', s.label, s.total > 0 ? s.done / s.total : 0, s.done, s.total)
          sidebar('mods', s.label, {
            doneFiles: s.done,
            totalFiles: s.total,
            doneBytes: 0,
            totalBytes: 0,
            speedBps: 0
          }, 4)
        },
        () => run.cancelled
      )
      check()

      // 4) 包内自带的 config / 资源 / 光影 / 那几十个 jar
      push('overrides', '展开整合包自带的配置与资源', 0, 0, 0)
      await ctx.packs.extractOverrides(
        pack,
        gameDir,
        (s) => {
          push('overrides', s.label, s.total > 0 ? s.done / s.total : 0, s.done, s.total)
          sidebar('mods', s.label, { doneFiles: s.done, totalFiles: s.total, doneBytes: 0, totalBytes: 0, speedBps: 0 }, 5)
        },
        () => run.cancelled
      )
      check()

      const tail = dl.failed.length ? `完成，${dl.failed.length} 个模组没下下来` : '导入完成'
      await ctx.instances.setImportState(instance.id, undefined)
      emitImport({
        instanceId: instance.id,
        stage: 'done',
        label: tail,
        stagePercent: 1,
        percent: 1,
        done: 1,
        total: 1
      })
      progress({
        taskId,
        title,
        stage: 'done',
        label: dl.failed.length ? tail : '导入完成，可以启动了',
        doneFiles: 1,
        totalFiles: 1,
        doneBytes: 0,
        totalBytes: 0,
        speedBps: 0,
        stageIndex: IMPORT_ORDER.length,
        stageCount: IMPORT_ORDER.length
      })
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)

      if (run.cancelled) {
        // 取消时 cancelImport 已经把实例和卡片删掉了，这里只收尾，别重复发事件
        await ctx.instances.remove(instance.id, true).catch(() => undefined)
        progress({
          taskId,
          title,
          stage: 'done',
          label: '已取消导入',
          doneFiles: 0,
          totalFiles: 0,
          doneBytes: 0,
          totalBytes: 0,
          speedBps: 0
        })
      } else {
        // 失败也要能被看见：卡片转成「导入中断」，日志里留一句原话
        await ctx.instances
          .setImportState(instance.id, {
            status: 'failed',
            stage: last.stage,
            stagePercent: last.stagePercent,
            percent: last.percent,
            label: '导入失败',
            done: last.done,
            total: last.total,
            startedAt,
            zipPath,
            error: message
          })
          .catch(() => undefined)
        emitImport({
          instanceId: instance.id,
          stage: 'done',
          label: '导入失败',
          stagePercent: 0,
          percent: 0,
          done: 0,
          total: 0,
          error: message
        })
        progress({
          taskId,
          title,
          stage: 'done',
          label: message,
          doneFiles: 0,
          totalFiles: 0,
          doneBytes: 0,
          totalBytes: 0,
          speedBps: 0
        })
      }
    } finally {
      importRuns.delete(instance.id)
    }
  }

  ipcMain.handle('modpack:pickZip', () =>
    guard(async () => {
      const res = await dialog.showOpenDialog({
        title: '选择整合包压缩包',
        filters: [{ name: '整合包', extensions: ['zip'] }],
        properties: ['openFile']
      })
      const file = res.filePaths?.[0]
      if (res.canceled || !file) return null
      return ctx.packs.peek(file)
    })
  )

  ipcMain.handle('modpack:importZip', (_e, zipPath: string, instanceName?: string) =>
    guard(async () => {
      const pack = await ctx.packs.peek(zipPath)
      const name = instanceName?.trim() || pack.name
      if (!pack.minecraft) {
        throw fail('E_MODPACK_FORMAT', '这个整合包没有声明游戏版本，没法自动补版本')
      }
      if (!pack.loader) {
        throw fail('E_MODPACK_LOADER', '没能识别这个整合包的模组加载器')
      }

      // 先落盘「导入中」的实例：玩家点完导入，实例页立刻能看到它
      const instance = await ctx.instances.create({
        name,
        gameVersion: pack.minecraft,
        versionId: pack.minecraft,
        loader: { kind: pack.loader.kind, version: pack.loader.version },
        memory: { minMb: 2048, maxMb: pack.recommendedRamMb ?? 8192 },
        window: { width: 1280, height: 720, fullscreen: false },
        source: { provider: 'local', title: pack.name, versionId: pack.version },
        importState: {
          status: 'importing',
          stage: 'parse',
          stagePercent: 0,
          percent: 0,
          label: '准备导入',
          done: 0,
          total: pack.files.length,
          startedAt: new Date().toISOString(),
          zipPath
        }
      })

      // 不等它跑完：把实例先还给界面，弹窗才能马上切进度态，关掉也照样继续
      void startImport(instance, pack, zipPath)
      return instance
    })
  )

  ipcMain.handle('modpack:cancelImport', (_e, instanceId: string) =>
    guard(async () => {
      const run = importRuns.get(instanceId)
      if (run) {
        run.cancelled = true
        // 立刻把卡片收掉，不等后台那一步跑完：
        // 版本下载不是本实例独有的（装在共享的 versions 目录），继续下完也不浪费
        await ctx.instances.remove(instanceId, true).catch(() => undefined)
        emitImport({
          instanceId,
          stage: 'done',
          label: '已取消导入',
          stagePercent: 0,
          percent: 0,
          done: 0,
          total: 0,
          cancelled: true
        })
        return null
      }
      // 启动器重启过、没有活着的任务：直接把半成品删掉
      await ctx.instances.remove(instanceId, true).catch(() => undefined)
      emitImport({
        instanceId,
        stage: 'done',
        label: '已取消导入',
        stagePercent: 0,
        percent: 0,
        done: 0,
        total: 0,
        cancelled: true
      })
      return null
    })
  )

  ipcMain.handle('modpack:retryImport', (_e, instanceId: string) =>
    guard(async () => {
      if (importRuns.has(instanceId)) {
        throw fail('E_IMPORT_RUNNING', '这个实例正在导入中')
      }
      const instance = await ctx.instances.get(instanceId)
      const zipPath = instance.importState?.zipPath
      if (!zipPath) {
        throw fail('E_MODPACK_FORMAT', '找不到原整合包的位置，请重新选一个 zip 导入')
      }
      const pack = await ctx.packs.peek(zipPath)
      if (!pack.minecraft || !pack.loader) {
        throw fail('E_MODPACK_FORMAT', '这个整合包缺少版本或加载器信息')
      }
      const next = await ctx.instances.setImportState(instanceId, {
        status: 'importing',
        stage: 'parse',
        stagePercent: 0,
        percent: 0,
        label: '重新导入',
        done: 0,
        total: pack.files.length,
        startedAt: new Date().toISOString(),
        zipPath
      })
      void startImport(next, pack, zipPath)
      return next
    })
  )

  /* ------------------------------------------------------ 卡片背景 */

  ipcMain.handle('instances:pickBackground', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const res = await dialog.showOpenDialog({
        title: '选择卡片背景图',
        filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
        properties: ['openFile']
      })
      const file = res.filePaths?.[0]
      if (res.canceled || !file) return null
      const saved = await saveBackground(file, ctx.paths.instanceDir(inst.slug))
      return ctx.instances.update(id, {
        background: { source: 'upload', file: saved, updatedAt: new Date().toISOString() }
      })
    })
  )

  ipcMain.handle('instances:autoBackground', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      const found = await findWorldImage(ctx.paths.instanceGameDir(inst.slug))
      if (!found) {
        throw fail('E_BACKGROUND_MISSING', ERROR_TEXT.E_BACKGROUND_MISSING)
      }
      const saved = await saveBackground(found.path, ctx.paths.instanceDir(inst.slug))
      const instance = await ctx.instances.update(id, {
        background: { source: found.source, file: saved, updatedAt: new Date().toISOString() }
      })
      return { instance, source: found.source }
    })
  )

  ipcMain.handle('instances:clearBackground', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      if (inst.background) {
        await fs
          .rm(path.join(ctx.paths.instanceDir(inst.slug), inst.background.file), { force: true })
          .catch(() => undefined)
      }
      return ctx.instances.update(id, { background: undefined })
    })
  )

  ipcMain.handle('instances:background', (_e, id: string) =>
    guard(async () => {
      const inst = await ctx.instances.get(id)
      if (!inst.background) return null
      try {
        const buf = await fs.readFile(path.join(ctx.paths.instanceDir(inst.slug), inst.background.file))
        return `data:image/jpeg;base64,${buf.toString('base64')}`
      } catch {
        return null
      }
    })
  )

  /* ---------------------------------------------------------- 系统 */

  ipcMain.handle('system:openPath', (_e, target: string) =>
    guard(async () => {
      // shell.openPath 失败时返回错误字符串而不是抛异常，吞掉它用户就只会看到"点了没反应"
      const error = await shell.openPath(target)
      if (error) throw fail('E_OPEN_PATH', `打不开这个位置：${error}`)
      return null
    })
  )

  ipcMain.handle('system:paths', () =>
    guard(async () => ({
      root: ctx.paths.root,
      instances: ctx.paths.instances,
      portable: ctx.dataRoot.portable,
      fallbackReason: ctx.dataRoot.fallbackReason
    }))
  )

  ipcMain.handle('system:pickJava', () =>
    guard(async () => {
      const res = await dialog.showOpenDialog({
        title: '选择 java 可执行文件',
        properties: ['openFile'],
        filters: process.platform === 'win32' ? [{ name: 'java', extensions: ['exe'] }] : []
      })
      return res.canceled ? null : (res.filePaths[0] ?? null)
    })
  )

  ipcMain.handle('system:logs', () =>
    guard(async () => {
      try {
        const files = await fs.readdir(ctx.paths.logsDir)
        return files.slice(-40).map((f) => path.join(ctx.paths.logsDir, f))
      } catch {
        return []
      }
    })
  )

  ipcMain.handle('system:storage', (_e, force?: boolean) => guard(() => ctx.storage.usage(Boolean(force))))

  ipcMain.handle('system:clearLogs', () =>
    guard(async () => {
      const removed = await ctx.storage.clearLogs()
      return removed
    })
  )

  ipcMain.handle('system:info', () =>
    guard(async () => {
      const cpus = os.cpus()
      return {
        appVersion: app.getVersion(),
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
        platform: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux',
        arch: process.arch,
        osVersion: os.release(),
        totalMemMb: Math.round(os.totalmem() / 1024 / 1024),
        cpuModel: (cpus[0]?.model ?? '未知处理器').replace(/\s+/g, ' ').trim(),
        cpuCores: cpus.length
      }
    })
  )

  /* ---------------------------------------------------------- 窗口 */

  ipcMain.handle('win:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
  })
  ipcMain.handle('win:toggleMaximize', () => {
    const win = BrowserWindow.getFocusedWindow()
    if (!win) return
    win.isMaximized() ? win.unmaximize() : win.maximize()
  })
  ipcMain.handle('win:close', () => {
    BrowserWindow.getFocusedWindow()?.close()
  })
}

function emptyTask(title: string): TaskProgress {
  return {
    taskId: crypto.randomUUID(),
    title,
    stage: 'done' as TaskStage,
    label: '',
    doneFiles: 0,
    totalFiles: 0,
    doneBytes: 0,
    totalBytes: 0,
    speedBps: 0
  }
}

/** 安装流水线的阶段顺序，前端拿它算「3 / 5 依赖库」 */
const INSTALL_STAGES: TaskStage[] = ['resolve', 'client', 'libraries', 'assets', 'natives']

export async function installVersion(
  ctx: AppContext,
  versionId: string,
  emit: (p: TaskProgress) => void
): Promise<void> {
  const taskId = crypto.randomUUID()
  const title = `安装 ${versionId}`
  const push = (
    stage: TaskStage,
    label: string,
    stats?: {
      doneFiles: number
      totalFiles: number
      doneBytes: number
      totalBytes: number
      speedBps: number
      elapsedMs: number
    }
  ): void => {
    emit({
      taskId,
      title,
      stage,
      label,
      doneFiles: stats?.doneFiles ?? 0,
      totalFiles: stats?.totalFiles ?? 0,
      doneBytes: stats?.doneBytes ?? 0,
      totalBytes: stats?.totalBytes ?? 0,
      speedBps: stats?.speedBps ?? 0,
      elapsedMs: stats?.elapsedMs ?? 0,
      stageIndex: Math.max(1, INSTALL_STAGES.indexOf(stage) + 1),
      stageCount: INSTALL_STAGES.length
    })
  }

  try {
    const res = await ctx.installer.install(versionId, {
      stage: (stage, label) => push(stage, label ?? ''),
      tick: (stage, s) => push(stage, s.current, s)
    })
    push('done', res.failed ? `${res.failed} 个资源文件未下载，游戏仍可启动` : '')
  } catch (e) {
    const err = e instanceof NovaError ? e : wrap('E_INSTALL', e, '安装失败')
    emit({
      taskId,
      title,
      stage: 'done',
      label: '',
      doneFiles: 0,
      totalFiles: 0,
      doneBytes: 0,
      totalBytes: 0,
      speedBps: 0,
      error: { code: err.code, message: err.message }
    })
    throw err
  }
}

/**
 * 保证有一个能跑的 Java。
 * 缺失时不报错让用户自己解决，而是直接下受管运行时——现代启动器的基本礼仪。
 */
export async function ensureJava(
  ctx: AppContext,
  major: number,
  emit: (p: TaskProgress) => void
): Promise<JavaRuntimeInfo> {
  const cfg = await ctx.config.load()
  const present = pickJava(await ctx.java.detect(), major, cfg.javaPreference)
  if (present) return present

  const taskId = crypto.randomUUID()
  const title = `安装 Java ${major}`
  const javaPath = await provisionJava(
    major,
    ctx.paths,
    ctx.pool,
    ctx.http,
    ctx.platform,
    ctx.mirror.mode,
    (p) => {
      emit({
        taskId,
        title,
        stage: 'java',
        label: p.phase === 'resolve' ? '本机没有匹配的 Java，正在选择下载源' : p.label,
        doneFiles: p.done,
        totalFiles: p.total,
        doneBytes: p.doneBytes,
        totalBytes: p.totalBytes,
        speedBps: p.speedBps,
        elapsedMs: p.elapsedMs,
        stageIndex: 1,
        stageCount: 1
      })
    }
  )

  const runtimes = await ctx.java.detect()
  await ctx.config.patch({ javaRuntimes: runtimes })
  const resolved = runtimes.find((j) => j.path === javaPath) ?? pickJava(runtimes, major, cfg.javaPreference)
  if (!resolved) {
    throw fail('E_JAVA_MISSING', `Java ${major} 已下载，但无法启动它；请到「设置 → Java 运行时」手动指定 java 路径`)
  }
  return resolved
}
