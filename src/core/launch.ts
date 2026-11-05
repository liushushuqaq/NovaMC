import path from 'node:path'
import fs from 'node:fs'
import { spawn, spawnSync, execFile, type ChildProcess } from 'node:child_process'
import type { GamePaths, PlatformInfo } from './paths'
import type { ResolvedVersion } from './types'
import type { Account, InstanceConfig, JavaRuntimeInfo } from './types'
import { expandArgs, legacySplit, rulesAllow, substitute, type OsContext } from './rules'
import { mavenPathOf, isForgeStubLibrary } from './installer'
import { fail } from './errors'

export interface BuildInput {
  resolved: ResolvedVersion
  instance: InstanceConfig
  account: Account
  java: JavaRuntimeInfo
  paths: GamePaths
  platform: PlatformInfo
  launcher: { name: string; version: string }
}

export interface LaunchCommand {
  command: string
  args: string[]
  cwd: string
  env: NodeJS.ProcessEnv
}

export function buildLaunchCommand(input: BuildInput): LaunchCommand {
  const { resolved, instance, account, java, paths, platform, launcher } = input

  const gameDir = paths.instanceGameDir(instance.slug)
  const nativesDir = paths.nativesDir(instance.slug)
  const classpath = buildClasspath(resolved, paths, platform)
  const features = {
    is_demo_user: false,
    has_custom_resolution: !instance.window.fullscreen,
    has_quick_plays_support: false,
    is_quick_play_singleplayer: false,
    is_quick_play_multiplayer: false,
    is_quick_play_realms: false
  }
  const ctx: OsContext = { name: platform.name, arch: platform.arch, version: platform.version, features }

  const vars: Record<string, string> = {
    auth_player_name: account.name,
    version_name: resolved.id,
    game_directory: gameDir,
    assets_root: paths.assets,
    assets_index_name: resolved.assets,
    auth_uuid: account.id.replace(/-/g, ''),
    auth_access_token: account.type === 'offline' ? '0' : '0',
    auth_session: account.type === 'offline' ? `token:${account.id}` : '0',
    user_type: account.type === 'offline' ? 'legacy' : 'msa',
    version_type: resolved.type,
    user_properties: '{}',
    clientid: '',
    auth_xuid: '',
    natives_directory: nativesDir,
    launcher_name: launcher.name,
    launcher_version: launcher.version,
    classpath,
    classpath_separator: path.delimiter,
    library_directory: paths.libraries,
    resolution_width: String(instance.window.width),
    resolution_height: String(instance.window.height),
    game_assets: paths.assetsVirtual()
  }

  // ---- JVM 参数 ----
  let jvmArgs: string[]
  if (resolved.arguments?.jvm?.length) {
    jvmArgs = expandArgs(resolved.arguments.jvm, ctx, vars)
  } else {
    jvmArgs = [`-Djava.library.path=${nativesDir}`, '-cp', classpath]
  }

  const memoryArgs = [`-Xms${instance.memory.minMb}M`, `-Xmx${instance.memory.maxMb}M`]
  // 不再自己塞 GC 调优参数：版本 JSON 里的 arguments.jvm 已经按该版本调好，
  // 额外加 -XX:G1NewSizePercent 这类实验开关一旦排在 -XX:+UnlockExperimentalVMOptions
  // 前面，JVM 会直接拒绝启动（"The unlock option must precede ..."）。
  // 实例级 JVM 参数仍然排在最后，优先级最高。
  jvmArgs = [...memoryArgs, ...jvmArgs, ...sanitizeUserArgs(instance.jvmArgs)]

  // ---- 游戏参数 ----
  let gameArgs: string[]
  if (resolved.arguments?.game?.length) {
    gameArgs = expandArgs(resolved.arguments.game, ctx, vars)
  } else if (resolved.minecraftArguments) {
    gameArgs = legacySplit(resolved.minecraftArguments).map((a) => substitute(a, vars))
  } else {
    gameArgs = [
      '--username', vars.auth_player_name,
      '--version', vars.version_name,
      '--gameDir', gameDir,
      '--assetsDir', paths.assets,
      '--assetIndex', vars.assets_index_name,
      '--uuid', vars.auth_uuid,
      '--accessToken', vars.auth_access_token,
      '--userType', vars.user_type,
      '--versionType', vars.version_type
    ]
  }

  if (instance.window.fullscreen) {
    gameArgs.push('--fullscreen')
  } else {
    gameArgs.push('--width', String(instance.window.width), '--height', String(instance.window.height))
  }
  gameArgs.push(...sanitizeUserArgs(instance.gameArgs))

  return {
    command: java.path,
    args: [...jvmArgs, resolved.mainClass, ...gameArgs],
    cwd: gameDir,
    env: { ...process.env, JAVA_TOOL_OPTIONS: '', _JAVA_OPTIONS: '' }
  }
}

function sanitizeUserArgs(args: string[]): string[] {
  return args.map((a) => a.trim()).filter(Boolean)
}

export function buildClasspath(resolved: ResolvedVersion, paths: GamePaths, platform: PlatformInfo): string {
  const ctx: OsContext = { name: platform.name, arch: platform.arch, version: platform.version, features: {} }
  const entries: string[] = []
  for (const lib of resolved.libraries) {
    if (!rulesAllow(lib.rules, ctx)) continue
    if (lib.natives) continue // legacy natives 走解压，不进 classpath
    if (isForgeStubLibrary(lib)) continue // Forge 空壳 client/server 库，不进 classpath
    const p = lib.downloads?.artifact?.path ?? mavenPathOf(lib.name)
    entries.push(paths.library(p))
  }
  entries.push(paths.versionJar(resolved.clientJarId))
  return entries.join(path.delimiter)
}

/* ---------------------------------------------------------------- 进程管理 */

export interface LaunchEvents {
  onLog(line: string): void
  onExit(info: { code: number | null; signal: NodeJS.Signals | null; crashLog?: string }): void
}

export class LaunchService {
  private child: ChildProcess | null = null
  private currentInstanceId: string | null = null
  private ring: string[] = []

  get runningInstanceId(): string | null {
    return this.currentInstanceId
  }

  /** 最近 n 行日志（给崩溃上报 / 诊断用） */
  lastLogLines(n = 60): string[] {
    return this.ring.slice(-n)
  }

  start(cmd: LaunchCommand, instanceId: string, events: LaunchEvents): { pid?: number } {
    if (this.child) throw fail('E_ALREADY_RUNNING', '已有游戏进程在运行')

    if (!fs.existsSync(cmd.cwd)) fs.mkdirSync(cmd.cwd, { recursive: true })

    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env,
      windowsHide: false,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.child = child
    this.currentInstanceId = instanceId
    this.ring = []

    const push = (chunk: Buffer) => {
      for (const line of chunk.toString().split(/\r?\n/)) {
        if (!line) continue
        this.ring.push(line)
        if (this.ring.length > 500) this.ring.shift()
        events.onLog(line)
      }
    }
    child.stdout?.on('data', push)
    child.stderr?.on('data', push)

    child.on('error', (e) => {
      events.onLog(`[launcher] 进程启动失败：${e.message}`)
    })

    child.on('exit', (code, signal) => {
      const crashLog = code === 0 ? undefined : this.buildCrashHint()
      this.child = null
      this.currentInstanceId = null
      events.onExit({ code, signal, crashLog })
    })

    return { pid: child.pid }
  }

  stop(): void {
    const child = this.child
    if (!child?.pid) return
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    } else {
      child.kill('SIGTERM')
      setTimeout(() => {
        if (this.child) this.child.kill('SIGKILL')
      }, 5000)
    }
  }

  /**
   * 退出应用时用。必须同步：异步的 taskkill 还没回来，进程就已经退出了，
   * 结果就是关掉启动器后游戏还在后台跑。
   */
  killNow(): void {
    const child = this.child
    if (!child?.pid) return
    if (process.platform === 'win32') {
      try {
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 })
      } catch {
        /* 进程可能已经退出 */
      }
    } else {
      try {
        child.kill('SIGKILL')
      } catch {
        /* 进程可能已经退出 */
      }
    }
    this.child = null
    this.currentInstanceId = null
  }

  private buildCrashHint(): string {
    const tail = this.ring.slice(-60).join('\n')
    const caused = this.ring.filter((l) => /Caused by|Exception|Error/i.test(l)).slice(-8)
    if (caused.length) return caused.join('\n')
    return tail
  }
}
