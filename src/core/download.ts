import path from 'node:path'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import crypto from 'node:crypto'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import type { HttpClient } from './http'
import { NovaError, wrap } from './errors'

export interface DownloadTask {
  url: string
  mirrors?: string[]
  dest: string
  sha1?: string
  size?: number
  label: string
}

export interface TickStats {
  doneFiles: number
  totalFiles: number
  /** 进度字节：已完成文件 + 正在传输的字节，用于画进度条 */
  doneBytes: number
  totalBytes: number
  /** 真实网络速率（不含跳过命中的文件） */
  speedBps: number
  current: string
  /** 当前正在传输的单个文件已传 / 总大小，单大文件时可画细粒度进度 */
  currentBytes: number
  currentTotal: number
  /** 本阶段已耗时，用来估剩余时间 */
  elapsedMs: number
}

export interface DownloadPoolOptions {
  concurrency: number
  retries: number
  timeoutMs: number
}

export interface RunOptions {
  /** 资源类文件：少量失败只警告，不让整个安装前功尽弃 */
  tolerateFailures?: boolean
  /** 容忍阈值，默认 max(20, 2%) */
  maxFailures?: number
  /** 用户点了取消：每轮取任务前问一次，能在一个文件之内停下来 */
  shouldAbort?: () => boolean
}

export interface RunResult {
  total: number
  skipped: number
  bytes: number
  failed: number
  /** 失败的具体任务，调用方要能区分「哪个文件没下下来」 */
  failedItems: { label: string; error: string }[]
}

export class AggregateDownloadError extends NovaError {
  constructor(public failures: { task: DownloadTask; error: unknown }[]) {
    super(
      'E_DOWNLOAD_FAILED',
      `${failures.length} 个文件下载失败：${failures
        .slice(0, 3)
        .map((f) => f.task.label)
        .join('、')}${failures.length > 3 ? ' 等' : ''}`,
      undefined,
      true,
      { failures: failures.length }
    )
  }
}

export async function hashFile(file: string, algo = 'sha1'): Promise<string | null> {
  try {
    await fsp.access(file)
  } catch {
    return null
  }
  return new Promise((resolve) => {
    const h = crypto.createHash(algo)
    const stream = fs.createReadStream(file)
    stream.on('data', (c) => h.update(c))
    stream.on('end', () => resolve(h.digest('hex')))
    stream.on('error', () => resolve(null))
  })
}

export async function verifyFile(file: string, sha1?: string): Promise<boolean> {
  if (!sha1) {
    try {
      await fsp.access(file)
      return true
    } catch {
      return false
    }
  }
  const actual = await hashFile(file)
  return actual === sha1.toLowerCase()
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 响应体连续这么久没有新字节就判定停滞，换源重试 */
const STALL_MS = 20_000
/** 单个文件跑够这么久之后才做速率判定，避免误杀正在爬坡的大文件 */
const SLOW_CHECK_AFTER = 25_000
/** 平均速度低于这个值基本就是撞上了坏节点：正常链路极少长期低于 5 KB/s */
const MIN_RATE_BPS = 5 * 1024

/**
 * 固定并发池。四条硬规则：
 *  1. 目标已存在且哈希正确 → 直接跳过（切换版本时命中率极高）
 *  2. 下载到 .part，校验通过才 rename，避免半截文件污染
 *  3. 单文件失败按"主源 → 镜像"轮转重试，指数退避
 *  4. 进度按**字节**推进，而不是按文件数——资源索引有三千多个小文件，
 *     按文件数走会让界面看起来卡死在 0%
 */
export class DownloadPool {
  constructor(
    private readonly http: HttpClient,
    private readonly opts: DownloadPoolOptions = { concurrency: 8, retries: 3, timeoutMs: 30_000 }
  ) {
    // 第二个参数传错（比如误传 GamePaths）会让 concurrency 变成 undefined，
    // Array.from({length: NaN}) 得到空数组，下载池会「零失败」但一个文件都没下。
    // 这里直接把错误暴露出来，别让它静默吞掉整批任务。
    if (!Number.isFinite(this.opts.concurrency) || !Number.isFinite(this.opts.retries)) {
      throw new Error(
        `DownloadPool 的第二个参数必须是下载选项 { concurrency, retries, timeoutMs }，收到的是 ${typeof this.opts}`
      )
    }
  }

  setConcurrency(n: number): void {
    // 资源对象是大量小文件，瓶颈在往返延迟而不是带宽，多开几条连接收益明显
    this.opts.concurrency = Math.max(1, Math.min(32, n))
  }

  setRetries(n: number): void {
    this.opts.retries = Math.max(1, Math.min(8, n))
  }

  setTimeoutMs(ms: number): void {
    this.opts.timeoutMs = Math.max(5_000, Math.min(120_000, ms))
  }

  async run(
    tasks: DownloadTask[],
    onTick?: (s: TickStats) => void,
    opts: RunOptions = {}
  ): Promise<RunResult> {
    const totalBytes = tasks.reduce((s, t) => s + (t.size ?? 0), 0)
    let doneFiles = 0
    let doneBytes = 0 // 已完成（含跳过）+ 正在传输
    let netBytes = 0 // 真实网络字节，算速率用
    let inflight = 0
    let skipped = 0
    let curBytes = 0
    let curTotal = 0
    const failures: { task: DownloadTask; error: unknown }[] = []
    const started = Date.now()
    let lastEmit = 0

    // 熔断：某个源在本次运行里连续失败到阈值就不再排队它。
    // 否则每个文件都要先撞一次墙再回落，几千个资源文件会把安装拖成几十分钟。
    const strikes = new Map<string, number>()
    const tripped = new Set<string>()
    const TRIP_AFTER = 3
    const noteFailure = (url: string): void => {
      const n = (strikes.get(url) ?? 0) + 1
      strikes.set(url, n)
      if (n >= TRIP_AFTER) tripped.add(url)
    }
    let speed = 0
    let lastSpeedAt = Date.now()
    let lastSpeedBytes = 0

    const emit = (current: string, force = false): void => {
      if (!onTick) return
      const now = Date.now()
      if (!force && now - lastEmit < 120) return
      lastEmit = now

      const dt = (now - lastSpeedAt) / 1000
      if (dt >= 0.4) {
        const instant = Math.max(0, (netBytes - lastSpeedBytes) / dt)
        // 指数平滑，避免单文件切换瞬间速率跳成 0
        speed = speed > 0 ? speed * 0.65 + instant * 0.35 : instant
        lastSpeedAt = now
        lastSpeedBytes = netBytes
      }

      onTick({
        doneFiles,
        totalFiles: tasks.length,
        doneBytes: doneBytes + inflight,
        totalBytes,
        speedBps: Math.round(speed),
        current,
        currentBytes: curBytes,
        currentTotal: curTotal,
        elapsedMs: now - started
      })
    }

    emit('', true)

    const worker = async (t: DownloadTask): Promise<void> => {
      if (await verifyFile(t.dest, t.sha1)) {
        doneFiles++
        doneBytes += t.size ?? 0
        skipped++
        emit(t.label)
        return
      }

      const allUrls = [t.url, ...(t.mirrors ?? [])]
      const maxRounds = Math.max(1, this.opts.retries)
      let lastError: unknown
      for (let round = 0; round < maxRounds; round++) {
        // 每轮重新挑一次源：本轮被熔断的源，下一轮就不再碰
        const live = allUrls.filter((u) => !tripped.has(u))
        const urls = live.length ? live : allUrls
        for (const url of urls) {
          const tmp = `${t.dest}.part`
          let attemptBytes = 0
          curBytes = 0
          curTotal = t.size ?? 0
          try {
            await fsp.mkdir(path.dirname(t.dest), { recursive: true })
            const body = await this.http.stream(url, { timeoutMs: this.opts.timeoutMs })
            // 边下边计量：字节一到就推进度，不等整个文件落地
            let lastChunkAt = Date.now()
            const attemptStart = lastChunkAt
            const meter = new Transform({
              transform(chunk: Buffer, _enc, cb) {
                lastChunkAt = Date.now()
                attemptBytes += chunk.length
                inflight += chunk.length
                netBytes += chunk.length
                curBytes = attemptBytes
                emit(t.label)
                cb(null, chunk)
              }
            })
            // 两种卡死都要掐断，否则进度会永远停在 99%：
            //  1. 完全没有新字节（连接吊死）
            //  2. 还有字节但远慢于本轮平均（撞上坏的 CDN 边缘节点）
            const watchdog = setInterval(() => {
              const now = Date.now()
              if (now - lastChunkAt > STALL_MS) {
                meter.destroy(new Error('传输停滞'))
                return
              }
              const elapsed = now - attemptStart
              if (elapsed < SLOW_CHECK_AFTER) return
              if (attemptBytes / (elapsed / 1000) < MIN_RATE_BPS) meter.destroy(new Error('速度过低'))
            }, 5000)
            try {
              await pipeline(Readable.fromWeb(body as never), meter, fs.createWriteStream(tmp))
            } finally {
              clearInterval(watchdog)
            }

            if (!(await verifyFile(tmp, t.sha1))) {
              await fsp.rm(tmp, { force: true })
              throw new Error(`SHA-1 校验不通过`)
            }
            await fsp.rename(tmp, t.dest)
            inflight -= attemptBytes
            doneFiles++
            doneBytes += t.size ?? attemptBytes
            curBytes = 0
            strikes.delete(url)
            emit(t.label)
            return
          } catch (e) {
            lastError = e
            inflight -= attemptBytes
            curBytes = 0
            noteFailure(url)
            await fsp.rm(tmp, { force: true }).catch(() => {})
          }
        }
        // 换源立刻重试，只有同一轮的重复才需要退避
        if (round < maxRounds - 1) await sleep(350 * 2 ** round + Math.random() * 200)
      }
      failures.push({ task: t, error: lastError })
    }

    const queue = [...tasks]
    await Promise.all(
      Array.from({ length: Math.min(this.opts.concurrency, queue.length || 1) }, async () => {
        while (queue.length) {
          if (opts.shouldAbort?.()) return
          const next = queue.shift()
          if (next) await worker(next)
        }
      })
    )
    curBytes = 0
    emit('', true)

    if (failures.length) {
      const allowance = opts.maxFailures ?? Math.max(20, Math.ceil(tasks.length * 0.02))
      // 整批都挂了通常意味着断网，而不是个别文件坏了，这种情况必须报错
      if (!opts.tolerateFailures || failures.length > allowance) throw new AggregateDownloadError(failures)
    }
    return {
      total: tasks.length,
      skipped,
      bytes: doneBytes,
      failed: failures.length,
      failedItems: failures.map((f) => ({
        label: f.task.label,
        error: f.error instanceof Error ? f.error.message : String(f.error)
      }))
    }
  }
}
