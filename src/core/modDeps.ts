import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import type { HttpClient } from './http'
import type { GamePaths } from './paths'
import type { DownloadPool, DownloadTask } from './download'
import type {
  InstanceConfig,
  MissingDependency,
  ModCandidate,
  ModDependencyReport
} from './types'

const MODRINTH = 'https://api.modrinth.com/v2'

/** 这些 id 由加载器/游戏本体提供，不该被当成缺失的模组 */
const BUILTIN = new Set([
  'minecraft',
  'java',
  'fabricloader',
  'fabric-loader',
  'fabric',
  'quilt_loader',
  'quilt-loader',
  'forge',
  'neoforge'
])

interface FabricModJson {
  id?: string
  name?: string
  version?: string
  depends?: Record<string, string | string[]>
  provides?: string[]
}

interface ModrinthVersion {
  id: string
  name: string
  version_number: string
  version_type: string
  date_published: string
  game_versions: string[]
  loaders: string[]
  files: {
    url: string
    filename: string
    primary: boolean
    size: number
    hashes: { sha1?: string }
  }[]
}

interface ModrinthProject {
  id: string
  slug: string
  title: string
}

/**
 * 模组依赖自检。
 *
 * Fabric 只在游戏进程启动后才校验 fabric.mod.json 的 depends，缺依赖就直接崩，
 * 启动器这时候只能看到一个非 0 退出码。所以这里在启动前先把 jar 读一遍，
 * 把缺的前置列出来，并尽量从 Modrinth 找到能直接装上的版本。
 */
export class ModDependencyService {
  private readonly cache = new Map<string, { sig: string; report: ModDependencyReport }>()

  constructor(
    private readonly http: HttpClient,
    private readonly pool: DownloadPool,
    private readonly paths: GamePaths
  ) {}

  /**
   * DownloadPool 的第二个构造参数是「下载选项」而不是路径。
   * 传错成 GamePaths 会让 concurrency / retries 变成 undefined，
   * Array.from({length: NaN}) 得到空数组 —— 一个 worker 都不会启动，
   * 下载池却报告「零失败」。这个坑很隐蔽，加个断言挡住。
   */

  clearCache(instanceId?: string): void {
    if (instanceId) this.cache.delete(instanceId)
    else this.cache.clear()
  }

  modsDir(slug: string): string {
    return path.join(this.paths.instanceGameDir(slug), 'mods')
  }

  async analyze(instance: InstanceConfig, force = false): Promise<ModDependencyReport> {
    const dir = this.modsDir(instance.slug)
    const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.jar')).sort()

    const sig = await this.signature(dir, files)
    const cached = this.cache.get(instance.id)
    if (!force && cached && cached.sig === sig) return cached.report

    const mods: { file: string; ids: string[]; depends: Record<string, string | string[]> }[] = []
    const provided = new Set<string>(BUILTIN)

    for (const file of files) {
      const metas = this.parseJar(path.join(dir, file))
      const ids: string[] = []
      for (const meta of metas) {
        if (meta.id) ids.push(meta.id)
        if (meta.id) provided.add(meta.id)
        for (const p of meta.provides ?? []) provided.add(p)
      }
      const depends: Record<string, string | string[]> = {}
      for (const meta of metas) Object.assign(depends, meta.depends ?? {})
      mods.push({ file, ids, depends })
    }

    const missingMap = new Map<string, MissingDependency>()
    for (const mod of mods) {
      for (const [id, range] of Object.entries(mod.depends)) {
        if (provided.has(id) || BUILTIN.has(id)) continue
        const owner = mod.ids[0] ?? mod.file
        const rangeText = Array.isArray(range) ? range.join(' || ') : String(range)
        const existing = missingMap.get(id)
        if (existing) {
          if (!existing.requiredBy.includes(owner)) existing.requiredBy.push(owner)
          // 同一个依赖被多个模组要求时，各自定义的范围必须同时满足。
          // 只看第一个会漏掉"另一个模组要 >=9.9.9"这种更严格的约束。
          const ranges = existing.allRanges ?? [existing.versionRange]
          if (!ranges.includes(rangeText)) ranges.push(rangeText)
          existing.allRanges = ranges
          existing.versionRange = ranges.join(' 且 ')
        } else {
          missingMap.set(id, {
            id,
            requiredBy: [owner],
            versionRange: rangeText,
            allRanges: [rangeText]
          })
        }
      }
    }

    const missing = [...missingMap.values()]
    // 只有 Fabric 实例才去 Modrinth 找，其它加载器查了也没用
    if (instance.loader.kind === 'fabric' && missing.length) {
      await Promise.all(
        missing.map(async (dep) => {
          dep.candidate = await this.resolve(dep.id, instance.gameVersion, dep.versionRange).catch(
            () => undefined
          )
        })
      )
    }

    const report: ModDependencyReport = { scanned: files.length, missing }
    this.cache.set(instance.id, { sig, report })
    return report
  }

  /** 下载所有能自动补齐的前置，返回装了什么 / 哪些没装上 */
  async installMissing(
    instance: InstanceConfig,
    report: ModDependencyReport,
    onTick?: (done: number, total: number, label: string) => void
  ): Promise<{ installed: string[]; failed: { id: string; message: string }[] }> {
    const dir = this.modsDir(instance.slug)
    await fs.mkdir(dir, { recursive: true })

    const installed: string[] = []
    const failed: { id: string; message: string }[] = []
    const tasks: DownloadTask[] = []
    /** task → 它对应哪个依赖 id */
    const owner = new Map<DownloadTask, string>()

    for (const dep of report.missing) {
      if (!dep.candidate) {
        failed.push({ id: dep.id, message: 'Modrinth 上没有匹配当前游戏版本与加载器的版本' })
        continue
      }
      if (dep.candidate.rangeMismatch) {
        // 版本对不上，装上去照样崩，不静默塞给用户
        failed.push({
          id: dep.id,
          message: `Modrinth 上没有满足「${dep.versionRange}」的版本（最高只有 ${dep.candidate.versionNumber}），需要手动处理`
        })
        continue
      }
      const dest = path.join(dir, await this.uniqueName(dir, dep.candidate.fileName))
      const task: DownloadTask = {
        url: dep.candidate.downloadUrl,
        dest,
        size: dep.candidate.size,
        sha1: dep.candidate.sha1,
        label: dep.candidate.fileName
      }
      tasks.push(task)
      owner.set(task, dep.id)
    }

    if (tasks.length) {
      const res = await this.pool.run(
        tasks,
        (st) => onTick?.(st.doneFiles, st.totalFiles, st.current),
        { tolerateFailures: true, maxFailures: tasks.length }
      )

      // 按落盘结果判定成败：下载池只给失败数量，不给具体是哪个，
      // 自己核对文件是否真的在磁盘上，别让用户以为装好了其实没有。
      const failedLabels = new Set(res.failedItems.map((f) => f.label))
      for (const task of tasks) {
        const id = owner.get(task) ?? task.label
        if (failedLabels.has(task.label)) {
          const reason = res.failedItems.find((f) => f.label === task.label)?.error ?? '下载失败'
          failed.push({ id, message: reason })
          continue
        }
        const st = await fs.stat(task.dest).catch(() => null)
        if (st && st.size > 0) {
          installed.push(id)
        } else if (failedLabels.size === 0 && res.failed === 0) {
          // 下载池说「零失败」但文件不在——说明整批任务压根没跑起来，
          // 不能当成成功，得让用户看到真实原因。
          failed.push({ id, message: '下载任务没有执行（下载池未启动任何 worker）' })
        } else {
          failed.push({ id, message: '文件没有落盘' })
        }
      }
      onTick?.(tasks.length, tasks.length, '')
    }

    this.cache.delete(instance.id)
    return { installed, failed }
  }

  /** mods 目录里已有同名文件时加序号，不覆盖用户自己的版本 */
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

  private async signature(dir: string, files: string[]): Promise<string> {
    const parts: string[] = []
    for (const f of files) {
      const st = await fs.stat(path.join(dir, f)).catch(() => null)
      parts.push(`${f}:${st?.size ?? 0}:${st ? Math.round(st.mtimeMs) : 0}`)
    }
    return crypto.createHash('sha1').update(parts.join('|')).digest('hex')
  }

  private parseJar(file: string): FabricModJson[] {
    try {
      return this.collect(new AdmZip(file), 0)
    } catch {
      return []
    }
  }

  /** META-INF/jars 下是 jar-in-jar 的内嵌依赖，它们也算"已提供"，否则会误报缺失 */
  private collect(zip: AdmZip, depth: number): FabricModJson[] {
    const out: FabricModJson[] = []
    try {
      if (zip.getEntry('fabric.mod.json')) {
        out.push(JSON.parse(zip.readAsText('fabric.mod.json')) as FabricModJson)
      }
    } catch {
      /* 坏 jar 跳过 */
    }
    if (depth >= 2) return out
    for (const entry of zip.getEntries()) {
      if (!/^META-INF\/jars\/.+\.jar$/i.test(entry.entryName)) continue
      try {
        out.push(...this.collect(new AdmZip(zip.readFile(entry) ?? undefined), depth + 1))
      } catch {
        /* 内嵌 jar 读不了就忽略 */
      }
    }
    return out
  }

  /**
   * 找一个能直接装上的版本。
   *
   * Modrinth 在国内抖动明显（实测三次里挂一次），所以每个请求都要重试；
   * 依赖名先当 slug 试，404 再换成下划线形式（fabric_api → fabric-api）。
   */
  private async resolve(
    id: string,
    gameVersion: string,
    range: string
  ): Promise<ModCandidate | undefined> {
    const slugs = id === id.toLowerCase() ? [id, id.replace(/_/g, '-')] : [id]
    let versions: ModrinthVersion[] = []

    for (const slug of slugs) {
      const url =
        `${MODRINTH}/project/${encodeURIComponent(slug)}/version` +
        `?game_versions=${encodeURIComponent(JSON.stringify([gameVersion]))}` +
        `&loaders=${encodeURIComponent(JSON.stringify(['fabric']))}`
      const data = await this.getJson<ModrinthVersion[]>(url)
      if (data?.length) {
        versions = data
        break
      }
    }
    if (!versions.length) return undefined

    // 依赖里写死的版本范围要真的能满足，否则装上去照样崩。
    // 多个模组对同一个依赖各写各的范围时，必须全部满足才算能装。
    // 满足不了时仍然给候选，但标记 rangeMismatch，让界面明确告诉用户版本对不上。
    const ranges = range.split(' 且 ').filter(Boolean)
    const ok = versions.filter((v) => ranges.every((r) => satisfies(v.version_number, r)))
    const mismatch = ok.length === 0
    const pool = mismatch ? versions : ok
    // 只接受正式版，beta/alpha 留着给用户自己选
    const stable = pool.filter((v) => v.version_type === 'release')
    const chosen = (stable.length ? stable : pool).sort(
      (a, b) => Date.parse(b.date_published) - Date.parse(a.date_published)
    )[0]
    if (!chosen) return undefined

    const file = chosen.files.find((f) => f.primary) ?? chosen.files[0]
    if (!file) return undefined

    // 项目元信息（标题）用批量接口一次拿完，避免每个依赖多打一次
    const projects = await this.getJson<ModrinthProject[]>(
      `${MODRINTH}/projects?ids=${encodeURIComponent(JSON.stringify([id]))}`
    )
    const project = projects?.find((p) => p.id === id || p.slug === id) ?? null

    return {
      projectId: project?.id ?? id,
      slug: project?.slug ?? id,
      title: project?.title ?? chosen.name,
      versionNumber: chosen.version_number,
      fileName: file.filename,
      downloadUrl: file.url,
      size: file.size,
      sha1: file.hashes.sha1,
      rangeMismatch: mismatch
    }
  }

  /** 带重试的 GET。Modrinth 单次成功率实测约 2/3，重试两次基本能兜住。 */
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

/**
 * 判断某个版本号是否满足 Fabric 的依赖范围。
 *
 * 支持 `*`、`>=1.2.3`、`>1.2.3`、`<=`、`<`、`=1.2.3`、精确值、
 * 空格分隔的与条件（`>=1.0.0 <2.0.0`）、以及 `||` 分隔的或条件。
 * 版本号形如 `0.116.17+1.21.1`，比较时只取数字段。
 */
export function satisfies(version: string, range: string): boolean {
  const range_ = (range ?? '*').trim()
  if (!range_ || range_ === '*') return true

  return range_
    .split('||')
    .some((alternative) => {
      const terms = alternative.trim().split(/\s+/).filter(Boolean)
      if (!terms.length) return true
      return terms.every((term) => {
        const m = /^([<>=~^]*)(.+)$/.exec(term)
        if (!m) return true
        const op = m[1] || '='
        const target = parseVersion(m[2])
        const actual = parseVersion(version)
        if (!target || !actual) return true
        const cmp = compare(actual, target)
        switch (op) {
          case '>=':
            return cmp >= 0
          case '>':
            return cmp > 0
          case '<=':
            return cmp <= 0
          case '<':
            return cmp < 0
          case '~':
          case '^':
            // 兼容约束：主版本相同即算满足
            return actual[0] === target[0] && cmp >= 0
          default:
            return cmp === 0
        }
      })
    })
}

function parseVersion(v: string): number[] | null {
  const core = v.split('+')[0].split('-')[0]
  const nums = core.split('.').map((n) => Number.parseInt(n, 10))
  if (!nums.length || nums.some((n) => Number.isNaN(n))) return null
  return nums
}

function compare(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0
    const y = b[i] ?? 0
    if (x !== y) return x > y ? 1 : -1
  }
  return 0
}
