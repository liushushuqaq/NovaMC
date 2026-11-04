import fs from 'node:fs/promises'
import type { GamePaths } from './paths'
import type { AppConfig } from './types'

export const DEFAULT_CONFIG: AppConfig = {
  theme: 'dark',
  density: 'comfortable',
  accent: 'green',
  javaRuntimes: [],
  javaPreference: 'auto',
  verifyOnLaunch: false,
  defaultMemory: { minMb: 2048, maxMb: 8192 },
  defaultWindow: { width: 1280, height: 720, fullscreen: false },
  mirror: 'auto',
  concurrency: 8,
  downloadRetries: 3,
  downloadTimeoutSec: 30
}

export class ConfigStore {
  private cache: AppConfig | null = null
  /** 串行化写入：设置页连点几下会并发触发 patch，同名 tmp 互相 rename 会 EPERM */
  private queue: Promise<unknown> = Promise.resolve()

  constructor(private readonly paths: GamePaths) {}

  async load(): Promise<AppConfig> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.paths.configFile, 'utf8')
      this.cache = { ...DEFAULT_CONFIG, ...(JSON.parse(raw) as Partial<AppConfig>) }
    } catch {
      this.cache = { ...DEFAULT_CONFIG }
    }
    return this.cache
  }

  async patch(patch: Partial<AppConfig>): Promise<AppConfig> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next: AppConfig = {
        ...current,
        ...patch,
        defaultMemory: { ...current.defaultMemory, ...(patch.defaultMemory ?? {}) },
        defaultWindow: { ...current.defaultWindow, ...(patch.defaultWindow ?? {}) }
      }
      this.cache = next
      await this.write(next)
      return next
    })
  }

  /** 恢复默认：保留已探测到的 Java 列表，否则用户得再点一次检测 */
  async reset(): Promise<AppConfig> {
    return this.enqueue(async () => {
      const current = await this.load()
      const next: AppConfig = {
        ...DEFAULT_CONFIG,
        javaRuntimes: current.javaRuntimes,
        javaPreference: current.javaPreference,
        lastInstanceId: current.lastInstanceId,
        activeAccountId: current.activeAccountId
      }
      this.cache = next
      await this.write(next)
      return next
    })
  }

  /** 前一次写完再开始下一次；失败不阻塞后续队列 */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  private async write(next: AppConfig): Promise<void> {
    const target = this.paths.configFile
    const tmp = `${target}.${process.pid}.${Date.now()}.tmp`
    await fs.mkdir(this.paths.root, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(next, null, 2))
    await fs.rename(tmp, target)
  }
}
