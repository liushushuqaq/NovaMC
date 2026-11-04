import fs from 'node:fs/promises'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fail } from './errors'
import { mavenPathOf } from './installer'

/**
 * Forge / NeoForge 的 processor 执行引擎。
 *
 * 这两个加载器跟 Fabric 有本质区别：它们给的不是一份现成的版本 JSON，
 * 而是一个 installer.jar，里面装着要真正执行的 Java 工具链。
 * 客户端至少要跑「重命名」和「打补丁」两步，产物是本地的 patched jar，
 * 下载流水线拿不到它。
 *
 * 引擎本身是通用的：给定 processor 定义、工具 jar 路径、Java 可执行文件，
 * 负责拼 classpath、替换占位符、跑进程、收集输出。
 * 具体每个加载器有哪几个 processor、产物叫什么，由各自的服务层决定。
 */

export interface ProcessorDef {
  /** 处理器对应的工具 jar（Maven 坐标，可能带 classifier） */
  jar: string
  /** 主类；不填则用 jar 的 Manifest 里的 Main-Class */
  class?: string
  /** 命令行参数，占位符会被替换 */
  args: string[]
  /** 只在这个端上执行；不填表示不限 */
  sides?: ('client' | 'server')[]
}

/** processor 里的占位符上下文 */
export interface ProcessorContext {
  /** 安装器 jar 自身 */
  installer: string
  /** 根目录（libraries 的父目录） */
  root: string
  /** Minecraft 客户端 jar 的绝对路径 */
  minecraftJar: string
  /** 端：client / server */
  side: 'client' | 'server'
  /** 解包后的 Minecraft 目录 */
  mcUnpacked: string
  /** 重命名后的中间产物 */
  mcOff: string
  /** Mojmap 映射文件 */
  mojmaps: string
  /** 补丁数据（lzma） */
  binpatch: string
  /** 最终产物 patched jar */
  patched: string
  /** 额外占位符 */
  extra?: Record<string, string>
}

export interface ProcessorRunResult {
  stdout: string
  stderr: string
  durationMs: number
}

export interface ProcessorRunOptions {
  javaPath: string
  /** 工具 jar 所在的 classpath 目录（一般是 libraries），用于定位工具 jar 本身 */
  classpathRoots: string[]
  /** 额外的 classpath jar（绝对路径），processor 依赖的库要全部列进来 */
  classpathJars?: string[]
  /** 超时（毫秒），默认 10 分钟 */
  timeoutMs?: number
  /** 工作目录 */
  cwd?: string
  /** 输出回调（用于进度提示） */
  onOutput?: (stream: 'stdout' | 'stderr', text: string) => void
}

/**
 * 把 `{XXX}` 占位符替换成实际值。
 * 未知的占位符原样保留——让 processor 自己报错，比我们猜一个错的路径好。
 */
export function substituteArgs(args: string[], ctx: ProcessorContext): string[] {
  const table: Record<string, string> = {
    INSTALLER: ctx.installer,
    ROOT: ctx.root,
    MINECRAFT_JAR: ctx.minecraftJar,
    SIDE: ctx.side,
    MC_UNPACKED: ctx.mcUnpacked,
    MC_OFF: ctx.mcOff,
    MOJMAPS: ctx.mojmaps,
    BINPATCH: ctx.binpatch,
    PATCHED: ctx.patched,
    ...(ctx.extra ?? {})
  }
  return args.map((a) => a.replace(/\{([A-Z_]+)\}/g, (m, key: string) => table[key] ?? m))
}

/**
 * 从工具 jar 的 Manifest 里读 Main-Class。
 * Forge 的处理器大多不给 class，全靠这个。
 */
export async function readMainClass(jarPath: string): Promise<string | null> {
  try {
    const buf = await fs.readFile(jarPath)
    // 只解析 zip 尾部目录，够拿到 MANIFEST.MF 就行
    const text = buf.toString('latin1')
    const eocd = text.lastIndexOf('PK\x05\x06')
    if (eocd < 0) return null
    const entries = text.lastIndexOf('PK\x05\x06', eocd)
    void entries
    const { default: AdmZip } = await import('adm-zip')
    const zip = new AdmZip(jarPath)
    const entry = zip.getEntry('META-INF/MANIFEST.MF')
    if (!entry) return null
    const manifest = zip.readAsText(entry)
    const m = /^Main-Class:\s*(.+)$/m.exec(manifest)
    return m ? m[1].trim() : null
  } catch {
    return null
  }
}

/**
 * 执行一个 processor。
 *
 * classpath 里除工具 jar 本身，还要带上它自己的依赖
 * （ForgeAutoRenamingTool 依赖 joptsimple，缺了会直接 NoClassDefFoundError）。
 */
export async function runProcessor(
  def: ProcessorDef,
  ctx: ProcessorContext,
  opts: ProcessorRunOptions
): Promise<ProcessorRunResult> {
  if (def.sides && def.sides.length && !def.sides.includes(ctx.side)) {
    // 这个 processor 不针对当前端，跳过
    return { stdout: '', stderr: '', durationMs: 0 }
  }

  const toolPath = path.join(...opts.classpathRoots, mavenPathOf(def.jar))
  await fs.access(toolPath).catch(() => {
    throw fail('E_PROCESSOR_MISSING', `处理器工具没下载成功：${def.jar}`)
  })

  const mainClass = def.class ?? (await readMainClass(toolPath))
  if (!mainClass) {
    throw fail('E_PROCESSOR_NO_MAIN', `处理器 ${def.jar} 既没有指定主类，Manifest 里也没有 Main-Class`)
  }

  const args = substituteArgs(def.args, ctx)
  // classpath = 工具 jar + 它自己的依赖（gson / joptsimple 等）。
  // classpathRoots 里的目录用于定位工具 jar；classpathJars 是调用方
  // 递归收集好的全部依赖 jar 绝对路径。
  const depJars = opts.classpathJars ?? []
  const classpath = [toolPath, ...depJars].join(path.delimiter)
  const timeout = opts.timeoutMs ?? 10 * 60_000

  const child = spawn(opts.javaPath, ['-cp', classpath, mainClass, ...args], {
    cwd: opts.cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let stdout = ''
  let stderr = ''
  child.stdout?.on('data', (d: Buffer) => {
    const t = d.toString('utf-8')
    stdout += t
    opts.onOutput?.('stdout', t)
  })
  child.stderr?.on('data', (d: Buffer) => {
    const t = d.toString('utf-8')
    stderr += t
    opts.onOutput?.('stderr', t)
  })

  const started = Date.now()
  const timer = setTimeout(() => {
    child.kill()
  }, timeout)

  const code = await new Promise<number | null>((resolve) => {
    child.on('error', (e) => {
      clearTimeout(timer)
      resolve(-1)
      stderr += `\n${e.message}`
    })
    child.on('close', (c) => {
      clearTimeout(timer)
      resolve(c)
    })
  })

  const durationMs = Date.now() - started
  if (code !== 0) {
    // processor 失败时 stderr 通常有真正的原因（缺文件、映射对不上），原样带出去
    const detail = (stderr.trim() || stdout.trim() || `退出码 ${code}`).slice(-1200)
    throw fail(
      'E_PROCESSOR_FAILED',
      `处理器 ${mainClass} 执行失败（退出码 ${code}）：${detail}`
    )
  }
  return { stdout, stderr, durationMs }
}

/**
 * 解析 maven-metadata.xml，取出版本列表。
 * 源经常抽风，所以调用方要负责重试；这里只管解析。
 */
export function parseMavenMetadata(xml: string): string[] {
  const out: string[] = []
  const re = /<version>([^<]+)<\/version>/g
  let m: RegExpExecArray | null
  while ((m = re.exec(xml)) !== null) out.push(m[1].trim())
  return out
}

/**
 * Forge 的版本号形如 `1.21.1-52.0.40`，前面是 MC 版本。
 * NeoForge 形如 `21.1.172`（对应 MC 1.21.1）或 `21.1.172-beta`。
 */
export function splitForgeVersion(v: string): { mc: string; build: string } | null {
  const forge = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(v)
  if (forge) return { mc: forge[1], build: forge[2] }

  // NeoForge：21.1.172 → 1.21.1；20.4.190 → 1.20.4
  const neo = /^(\d+)\.(\d+)\.(\d+)$/.exec(v)
  if (neo) return { mc: `1.${neo[1]}.${neo[2]}`, build: neo[3] }

  // 新年份制：26.1.2 → 1.21.x？无法从版本号本身确定，需要外部映射
  return null
}
