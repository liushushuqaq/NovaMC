import fs from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import AdmZip from 'adm-zip'
import type { DownloadPool } from './download'
import type { HttpClient } from './http'
import type { GamePaths, PlatformInfo } from './paths'
import type { MirrorMode } from './types'
import { fail, wrap } from './errors'

const exec = promisify(execFile)
const JAVA_BIN = process.platform === 'win32' ? 'java.exe' : 'java'

/** 清华 TUNA 的 Adoptium 镜像，与官方产物同源，国内速度差异在一个数量级上 */
const TUNA = 'https://mirrors.tuna.tsinghua.edu.cn/Adoptium'
const ADOPTIUM = 'https://api.adoptium.net/v3/binary/latest'

export interface ProvisionProgress {
  phase: 'resolve' | 'download' | 'extract' | 'done'
  label: string
  done: number
  total: number
  doneBytes: number
  totalBytes: number
  speedBps: number
  elapsedMs: number
}

interface ArchiveCandidate {
  url: string
  size?: number
}

/**
 * 受管 Java 运行时。
 *
 * 顺序上先试国内镜像、再回落 Adoptium 官方，因为官方走 GitHub Release，
 * 国内实测只有几十 KB/s —— 一个 45 MB 的 JRE 要下二十分钟，等于没有这个功能。
 */
export async function provisionJava(
  major: number,
  paths: GamePaths,
  pool: DownloadPool,
  http: HttpClient,
  platform: PlatformInfo,
  mirrorMode: MirrorMode,
  onProgress?: (p: ProvisionProgress) => void
): Promise<string> {
  const existing = await findManagedJava(paths, major)
  if (existing) {
    onProgress?.({ phase: 'done', label: existing, done: 1, total: 1, doneBytes: 0, totalBytes: 0, speedBps: 0, elapsedMs: 0 })
    return existing
  }

  if (platform.arch === 'x86') throw fail('E_JAVA_ARCH_MISMATCH', '32 位系统没有可用的受管 Java 运行时，请手动安装 Java 8')
  const os = platform.name === 'osx' ? 'mac' : platform.name
  const arch = platform.arch === 'arm64' ? 'aarch64' : 'x64'

  onProgress?.({ phase: 'resolve', label: '选择下载源', done: 0, total: 1, doneBytes: 0, totalBytes: 0, speedBps: 0, elapsedMs: 0 })
  const candidates = await resolveCandidates(http, major, os, arch, mirrorMode)
  if (!candidates.length) throw fail('E_JAVA_DOWNLOAD', `找不到 Java ${major} 的可用下载源`)
  const primary = candidates[0]

  const tmpDir = path.join(paths.root, 'tmp')
  await fs.mkdir(tmpDir, { recursive: true })
  const archive = path.join(tmpDir, `jre-${major}.bin`)
  await fs.rm(archive, { force: true }).catch(() => {})

  try {
    await pool.run(
      [
        {
          url: primary.url,
          mirrors: candidates.slice(1).map((c) => c.url),
          dest: archive,
          size: primary.size,
          label: `Java ${major} 运行时 · ${new URL(primary.url).hostname}`
        }
      ],
      (t) =>
        onProgress?.({
          phase: 'download',
          label: `Java ${major} 运行时`,
          done: t.doneFiles,
          total: t.totalFiles,
          doneBytes: t.doneBytes,
          totalBytes: t.totalBytes,
          speedBps: t.speedBps,
          elapsedMs: t.elapsedMs
        })
    )
  } catch (e) {
    throw wrap('E_JAVA_DOWNLOAD', e, 'Java 运行时下载失败，请检查网络，或在设置里切换下载源后重试')
  }

  onProgress?.({
    phase: 'extract',
    label: '解压运行时',
    done: 0,
    total: 1,
    doneBytes: 0,
    totalBytes: 0,
    speedBps: 0,
    elapsedMs: 0
  })

  // 先解到暂存目录：中断时不会在 runtime/ 里留下"看着存在、其实是残骸"的目录
  const staging = path.join(tmpDir, `jre-${major}-x`)
  await fs.rm(staging, { recursive: true, force: true })
  await fs.mkdir(staging, { recursive: true })
  try {
    await extractArchive(archive, staging)
    const entries = await fs.readdir(staging)
    if (!entries.length) throw new Error('压缩包为空')
    const rootEntry = entries.length === 1 ? entries[0] : null
    const from = rootEntry ? path.join(staging, rootEntry) : staging
    const dirName = rootEntry ?? `jre-${major}`
    const to = path.join(paths.runtimes, dirName)
    await fs.rm(to, { recursive: true, force: true })
    await fs.mkdir(paths.runtimes, { recursive: true })
    await fs.rename(from, to)
  } catch (e) {
    throw wrap('E_EXTRACT_FAILED', e, '解压 Java 运行时失败')
  } finally {
    await fs.rm(staging, { recursive: true, force: true }).catch(() => {})
    await fs.rm(archive, { force: true }).catch(() => {})
  }

  const found = await findManagedJava(paths, major)
  if (!found) throw fail('E_JAVA_MISSING', '运行时解压后未找到 java 可执行文件')

  onProgress?.({ phase: 'done', label: found, done: 1, total: 1, doneBytes: 0, totalBytes: 0, speedBps: 0, elapsedMs: 0 })
  return found
}

/** 按镜像偏好排序：国内镜像优先，官方兜底 */
async function resolveCandidates(
  http: HttpClient,
  major: number,
  os: string,
  arch: string,
  mode: MirrorMode
): Promise<ArchiveCandidate[]> {
  const list: ArchiveCandidate[] = []
  if (mode !== 'official') {
    for (const item of await listTuna(http, major, os, arch).catch(() => [])) list.push(item)
  }
  list.push({ url: `${ADOPTIUM}/${major}/ga/${os}/${arch}/jre/hotspot/normal/eclipse` })

  // 只探测主源体积：备用源不参与进度分母，探它反而会拖慢"点下去就有反应"的那一下
  list[0].size = (await probeSize(http, list[0].url)) ?? undefined
  return list
}

async function listTuna(http: HttpClient, major: number, os: string, arch: string): Promise<ArchiveCandidate[]> {
  const dir = `${TUNA}/${major}/jre/${arch}/${os}`
  const html = await http.text(`${dir}/`, { timeoutMs: 12_000 })
  const files = [...html.matchAll(/href="([^"?]+\.(?:zip|tar\.gz))"/g)].map((m) => decodeURIComponent(m[1]))
  const ranked = files
    .map((file) => ({ file, score: versionScore(file) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
  return ranked.slice(0, 2).map(({ file }) => ({ url: `${dir}/${encodeURIComponent(file)}` }))
}

/** 从 OpenJDK21U-jre_x64_windows_hotspot_21.0.13_9.zip 里取 21.0.13.9 这类版本号用于排序 */
function versionScore(file: string): number {
  const m = /_(\d+(?:\.\d+)+)(?:_(\d+))?\.(?:zip|tar\.gz)$/.exec(file)
  if (!m) return 0
  const parts = [...m[1].split('.').map(Number), Number(m[2] ?? 0)]
  return parts.reduce((acc, n) => acc * 1000 + n, 0)
}

async function probeSize(http: HttpClient, url: string): Promise<number | null> {
  try {
    const res = await http.raw(url, {
      method: 'HEAD',
      // 主源在国内，HEAD 通常几十毫秒；超时就走"体积未知"的降级展示，不卡住安装
      timeoutMs: 4000
    })
    const len = Number(res.headers.get('content-length') ?? 0)
    return len > 0 ? len : null
  } catch {
    return null
  }
}

async function extractArchive(archive: string, dest: string): Promise<void> {
  const fd = await fs.open(archive, 'r')
  const head = Buffer.alloc(2)
  try {
    await fd.read(head, 0, 2, 0)
  } finally {
    await fd.close()
  }
  const isZip = head[0] === 0x50 && head[1] === 0x4b // PK
  if (isZip) {
    const zip = new AdmZip(archive)
    zip.extractAllTo(dest, true)
    return
  }
  // tar.gz / tar.xz：交给系统 tar，Win10+ 自带 bsdtar
  await exec('tar', ['-xf', archive, '-C', dest], { timeout: 180_000 })
}

export async function findManagedJava(paths: GamePaths, major: number): Promise<string | null> {
  let dirs: string[] = []
  try {
    dirs = await fs.readdir(paths.runtimes)
  } catch {
    return null
  }
  // 用数字边界匹配，避免要 Java 8 时把 jdk-18 认成目标
  const want = new RegExp(`(^|[^0-9])${major}([^0-9]|$)`)
  for (const dir of dirs) {
    if (!want.test(dir)) continue
    for (const rel of javaBinCandidates(dir)) {
      const candidate = path.join(paths.runtimes, rel)
      try {
        await fs.access(candidate)
        return candidate
      } catch {
        /* 继续找 */
      }
    }
  }
  return null
}

/** macOS 的 JRE 在 Contents/Home 下，与 Linux/Windows 的布局不同 */
export function javaBinCandidates(dir: string): string[] {
  return [path.join(dir, 'bin', JAVA_BIN), path.join(dir, 'Contents', 'Home', 'bin', JAVA_BIN)]
}
