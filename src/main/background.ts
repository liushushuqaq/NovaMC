import fs from 'node:fs/promises'
import path from 'node:path'
import { nativeImage } from 'electron'
import { fail, ERROR_TEXT } from '../core/errors'

/**
 * 首页卡片背景图。
 *
 * 只做三件事：按 16:9 从中间裁、缩到 1920 宽、压成 jpg。
 * 用 Electron 自带的 nativeImage，不额外引 sharp（那玩意儿要编译原生模块）。
 */

const TARGET_RATIO = 16 / 9
const MAX_WIDTH = 1920
const JPEG_QUALITY = 86

/** 文件名固定成 background.jpg，删掉再存不会积压旧图 */
export const BACKGROUND_FILE = 'background.jpg'

/** 把任意图片处理成实例目录里的 background.jpg */
export async function saveBackground(src: string, instanceDir: string): Promise<string> {
  const img = nativeImage.createFromPath(src)
  if (img.isEmpty()) {
    throw fail('E_BACKGROUND_UNSUPPORTED', ERROR_TEXT.E_BACKGROUND_UNSUPPORTED)
  }

  const size = img.getSize()
  if (!size.width || !size.height) {
    throw fail('E_BACKGROUND_UNSUPPORTED', ERROR_TEXT.E_BACKGROUND_UNSUPPORTED)
  }

  let work = img
  const ratio = size.width / size.height
  if (ratio > TARGET_RATIO) {
    // 太宽：左右各切掉一点
    const w = Math.round(size.height * TARGET_RATIO)
    work = work.crop({ x: Math.round((size.width - w) / 2), y: 0, width: w, height: size.height })
  } else if (ratio < TARGET_RATIO) {
    // 太高：上下各切掉一点
    const h = Math.round(size.width / TARGET_RATIO)
    work = work.crop({ x: 0, y: Math.round((size.height - h) / 2), width: size.width, height: h })
  }

  if (work.getSize().width > MAX_WIDTH) {
    work = work.resize({ width: MAX_WIDTH, quality: 'good' })
  }

  await fs.mkdir(instanceDir, { recursive: true })
  await fs.writeFile(path.join(instanceDir, BACKGROUND_FILE), work.toJPEG(JPEG_QUALITY))
  return BACKGROUND_FILE
}

/**
 * 自动找图：优先最近玩过的存档 icon.png（就是存档列表里那个小缩略图），
 * 没有就退到 screenshots/ 里最新的一张。两样都没有就返回 null，界面保持渐变。
 */
export async function findWorldImage(
  gameDir: string
): Promise<{ path: string; source: 'world' | 'screenshot' } | null> {
  const savesDir = path.join(gameDir, 'saves')
  const worlds = await fs.readdir(savesDir).catch(() => [] as string[])
  let newestWorld: { file: string; mtime: number } | null = null
  for (const world of worlds) {
    const icon = path.join(savesDir, world, 'icon.png')
    const stat = await fs.stat(icon).catch(() => null)
    if (stat?.isFile() && (!newestWorld || stat.mtimeMs > newestWorld.mtime)) {
      newestWorld = { file: icon, mtime: stat.mtimeMs }
    }
  }
  if (newestWorld) return { path: newestWorld.file, source: 'world' }

  const shotsDir = path.join(gameDir, 'screenshots')
  const shots = await fs.readdir(shotsDir).catch(() => [] as string[])
  let newestShot: { file: string; mtime: number } | null = null
  for (const name of shots) {
    if (!/\.(png|jpe?g|webp)$/i.test(name)) continue
    const full = path.join(shotsDir, name)
    const stat = await fs.stat(full).catch(() => null)
    if (stat?.isFile() && (!newestShot || stat.mtimeMs > newestShot.mtime)) {
      newestShot = { file: full, mtime: stat.mtimeMs }
    }
  }
  return newestShot ? { path: newestShot.file, source: 'screenshot' } : null
}
