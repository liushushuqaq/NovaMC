import fs from 'node:fs/promises'
import path from 'node:path'
import type { StorageSlice, StorageUsage } from './types'
import type { GamePaths } from './paths'

/**
 * 目录占用统计。几千个资源对象逐个 stat 大约 1～2 秒，
 * 所以结果缓存 30 秒——设置页来回切换不会每次都重扫。
 */
const CACHE_TTL = 30_000

async function measure(root: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const stack: string[] = [root]
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) break
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          stack.push(full)
        } else if (entry.isFile()) {
          try {
            const st = await fs.stat(full)
            bytes += st.size
            files += 1
          } catch {
            /* 扫描期间被删掉的文件直接跳过 */
          }
        }
      }
    } catch {
      continue
    }
  }
  return { bytes, files }
}

export class StorageService {
  private cache: StorageUsage | null = null

  constructor(private readonly paths: GamePaths) {}

  async usage(force = false): Promise<StorageUsage> {
    if (!force && this.cache && Date.now() - this.cache.scannedAt < CACHE_TTL) return this.cache

    const targets: { key: string; label: string; dir: string }[] = [
      { key: 'versions', label: '游戏核心', dir: this.paths.versions },
      { key: 'libraries', label: '依赖库', dir: this.paths.libraries },
      { key: 'assets', label: '资源文件', dir: this.paths.assets },
      { key: 'instances', label: '实例与存档', dir: this.paths.instances },
      { key: 'runtime', label: 'Java 运行时', dir: this.paths.runtimes },
      { key: 'logs', label: '日志', dir: this.paths.logsDir }
    ]

    const slices: StorageSlice[] = []
    for (const t of targets) {
      const { bytes, files } = await measure(t.dir)
      slices.push({ key: t.key, label: t.label, bytes, files })
    }
    slices.sort((a, b) => b.bytes - a.bytes)

    const usage: StorageUsage = {
      total: slices.reduce((s, x) => s + x.bytes, 0),
      slices,
      scannedAt: Date.now()
    }
    this.cache = usage
    return usage
  }

  invalidate(): void {
    this.cache = null
  }

  /** 清空日志目录，返回删掉的文件数 */
  async clearLogs(): Promise<number> {
    let removed = 0
    try {
      const files = await fs.readdir(this.paths.logsDir, { withFileTypes: true })
      for (const f of files) {
        if (!f.isFile()) continue
        try {
          await fs.rm(path.join(this.paths.logsDir, f.name), { force: true })
          removed += 1
        } catch {
          /* 正被占用的日志跳过 */
        }
      }
    } catch {
      return 0
    }
    this.invalidate()
    return removed
  }
}
