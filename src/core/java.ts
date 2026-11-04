import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import type { JavaRuntimeInfo } from './types'

const exec = promisify(execFile)

const IS_WIN = process.platform === 'win32'
const JAVA_BIN = IS_WIN ? 'java.exe' : 'java'

async function safeList(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir)
  } catch {
    return []
  }
}

/** 用 -XshowSettings 探测版本，比解析 `java -version` 的引号格式稳 */
export async function probeJava(bin: string): Promise<JavaRuntimeInfo | null> {
  try {
    await fs.access(bin)
  } catch {
    return null
  }
  try {
    const { stdout, stderr } = await exec(bin, ['-XshowSettings:properties', '-version'], {
      timeout: 5000,
      windowsHide: true,
      maxBuffer: 1 << 20
    })
    const text = `${stdout}\n${stderr}`
    const version = /java\.version = (\S+)/.exec(text)?.[1]
    if (!version) return null
    const major = version.startsWith('1.') ? Number(version.split('.')[1]) : Number(version.split('.')[0])
    const vendor = /java\.vendor = (.+)/.exec(text)?.[1]?.trim()
    return { path: bin, version, major, vendor, managed: false }
  } catch {
    return null
  }
}

export async function detectJavaRuntimes(customPaths: string[] = []): Promise<JavaRuntimeInfo[]> {
  const candidates = new Set<string>()
  const add = (p?: string) => {
    if (p) candidates.add(p)
  }

  add(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', JAVA_BIN) : undefined)

  if (IS_WIN) {
    const roots = [
      'C:\\Program Files\\Java',
      'C:\\Program Files\\Eclipse Adoptium',
      'C:\\Program Files\\Microsoft',
      'C:\\Program Files\\Amazon Corretto',
      'C:\\Program Files\\Zulu',
      'C:\\Program Files\\BellSoft',
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Eclipse Adoptium') : undefined,
      process.env.USERPROFILE ? path.join(process.env.USERPROFILE, '.jdks') : undefined
    ].filter(Boolean) as string[]
    for (const root of roots) {
      for (const dir of await safeList(root)) add(path.join(root, dir, 'bin', JAVA_BIN))
    }
    try {
      const { stdout } = await exec('where', ['java'], { windowsHide: true })
      stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(add)
    } catch {
      /* PATH 里没有 java 很正常 */
    }
    for (const p of (process.env.PATH ?? '').split(';')) add(path.join(p, JAVA_BIN))
  } else if (process.platform === 'darwin') {
    try {
      const { stdout, stderr } = await exec('/usr/libexec/java_home', ['-V'], { timeout: 5000 })
      const text = `${stdout}\n${stderr}`
      for (const m of text.matchAll(/"([^"]*\/Contents\/Home)"/g)) add(path.join(m[1], 'bin', JAVA_BIN))
    } catch {
      /* 没装 Oracle/OpenJDK 时命令会失败 */
    }
    for (const base of ['/Library/Java/JavaVirtualMachines', path.join(os.homedir(), 'Library/Java/JavaVirtualMachines')]) {
      for (const dir of await safeList(base)) add(path.join(base, dir, 'Contents', 'Home', 'bin', JAVA_BIN))
    }
    add('/opt/homebrew/opt/openjdk/bin/java')
    add('/usr/local/opt/openjdk/bin/java')
  } else {
    try {
      const { stdout } = await exec('update-alternatives', ['--list', 'java'], { timeout: 4000 })
      stdout
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .forEach(add)
    } catch {
      /* 非 Debian 系没有该命令 */
    }
    for (const base of ['/usr/lib/jvm', '/usr/java', path.join(os.homedir(), '.sdkman/candidates/java')]) {
      for (const dir of await safeList(base)) add(path.join(base, dir, 'bin', JAVA_BIN))
    }
    for (const p of (process.env.PATH ?? '').split(':')) add(path.join(p, JAVA_BIN))
  }

  customPaths.forEach(add)

  const found: JavaRuntimeInfo[] = []
  const seen = new Set<string>()
  for (const candidate of candidates) {
    const info = await probeJava(candidate)
    if (!info) continue
    const key = `${info.version}@${path.dirname(path.dirname(info.path))}`
    if (seen.has(key)) continue
    seen.add(key)
    found.push(info)
  }
  return found.sort((a, b) => b.major - a.major)
}

/** 优先级：用户指定的路径 > 主版本完全匹配 > 更高版本里最低的那个 */
export function pickJava(
  runtimes: JavaRuntimeInfo[],
  requiredMajor: number,
  preference?: string
): JavaRuntimeInfo | null {
  if (preference && preference !== 'auto') {
    const hit = runtimes.find((r) => r.path === preference)
    if (hit && hit.major >= requiredMajor) return hit
  }
  const exact = runtimes.filter((r) => r.major === requiredMajor)
  if (exact.length) return exact[0]
  const higher = runtimes.filter((r) => r.major > requiredMajor).sort((a, b) => a.major - b.major)
  return higher[0] ?? null
}

export function javaHomeOf(bin: string): string {
  return path.dirname(path.dirname(bin))
}
