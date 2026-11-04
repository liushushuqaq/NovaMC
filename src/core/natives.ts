import fs from 'node:fs/promises'
import path from 'node:path'
import AdmZip from 'adm-zip'
import type { Library } from './types'
import { fail, wrap } from './errors'

/**
 * legacy（1.12-）的 natives 是带 classifier 的 jar，需要解压到 natives 目录；
 * 1.19+ 直接以普通 artifact 形式挂在 classpath 上，由 LWJGL 自己解压，无需处理。
 */
export function nativeClassifier(lib: Library, osName: string, arch: string): string | null {
  if (!lib.natives) return null
  const key = lib.natives[osName]
  if (!key) return null
  return key.replace('${arch}', arch === 'x64' ? '64' : arch === 'arm64' ? 'arm64' : '32')
}

export async function extractNatives(
  jars: { file: string; exclude: string[] }[],
  destDir: string
): Promise<void> {
  if (!jars.length) return
  await fs.mkdir(destDir, { recursive: true })

  for (const { file, exclude } of jars) {
    let zip: AdmZip
    try {
      zip = new AdmZip(file)
    } catch (e) {
      throw wrap('E_EXTRACT_FAILED', e, `解压 ${path.basename(file)} 失败`)
    }
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue
      const name = entry.entryName.replace(/\\/g, '/')
      if (name.startsWith('META-INF/')) continue
      if (exclude.some((rule) => name.startsWith(rule))) continue
      const target = path.join(destDir, name)
      // 防路径穿越
      const resolved = path.resolve(target)
      if (!resolved.startsWith(path.resolve(destDir) + path.sep)) {
        throw fail('E_EXTRACT_FAILED', `非法的压缩包条目：${name}`)
      }
      await fs.mkdir(path.dirname(resolved), { recursive: true })
      await fs.writeFile(resolved, entry.getData())
    }
  }
}

/** 清空 natives 目录，避免旧版本残留的 dll/so 干扰 */
export async function resetDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })
}
