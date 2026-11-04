import fs from 'node:fs/promises'
import crypto from 'node:crypto'
import type { GamePaths } from './paths'
import type { ConfigStore } from './config'
import type { Account } from './types'
import { fail } from './errors'
import { isPng, pngSize } from './png'

/**
 * 与 Java 端 UUID.nameUUIDFromBytes(("OfflinePlayer:" + name).getBytes(UTF_8)) 完全一致，
 * 否则同一离线账号在服务器白名单里会对不上。
 */
export function offlineUuid(name: string): string {
  const hash = crypto.createHash('md5').update(`OfflinePlayer:${name}`, 'utf8').digest()
  hash[6] = (hash[6] & 0x0f) | 0x30 // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80 // variant RFC 4122
  const hex = hash.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

export class AccountStore {
  private cache: Account[] | null = null

  constructor(
    private readonly paths: GamePaths,
    private readonly config: ConfigStore
  ) {}

  async list(): Promise<Account[]> {
    if (this.cache) return this.cache
    try {
      const raw = await fs.readFile(this.paths.accountsFile, 'utf8')
      this.cache = JSON.parse(raw) as Account[]
    } catch {
      this.cache = []
    }
    return this.cache
  }

  async addOffline(name: string, skinModel: 'classic' | 'slim' = 'classic'): Promise<Account> {
    const trimmed = name.trim()
    if (!/^[A-Za-z0-9_]{3,16}$/.test(trimmed)) {
      throw fail('E_INVALID_NAME', '用户名需为 3-16 位字母、数字或下划线')
    }
    const list = await this.list()
    if (list.some((a) => a.name.toLowerCase() === trimmed.toLowerCase())) {
      throw fail('E_DUPLICATE_ACCOUNT', '已存在同名账号')
    }
    const account: Account = {
      id: offlineUuid(trimmed),
      name: trimmed,
      type: 'offline',
      skinModel,
      createdAt: new Date().toISOString()
    }
    await this.save([...list, account])
    return account
  }

  async remove(id: string): Promise<void> {
    const list = await this.list()
    await this.save(list.filter((a) => a.id !== id))
    const cfg = await this.config.load()
    if (cfg.activeAccountId === id) await this.config.patch({ activeAccountId: undefined })
  }

  /**
   * 给账号设置自定义皮肤。
   *
   * 皮肤必须是 64×64 的 PNG（Minecraft 标准展开图），
   * 两层（本体 + overlay）都会被保留，渲染时自动叠加。
   */
  async setSkin(id: string, skinPath: string): Promise<Account> {
    const list = await this.list()
    const idx = list.findIndex((a) => a.id === id)
    if (idx < 0) throw fail('E_ACCOUNT_MISSING', '账号不存在')

    // 校验：必须是 PNG，且尺寸为 64×64
    const buf = await fs.readFile(skinPath)
    if (!isPng(buf)) {
      throw fail('E_SKIN_INVALID', '皮肤文件必须是 PNG 格式')
    }
    const dim = pngSize(buf)
    if (!dim || dim.width !== 64 || dim.height !== 64) {
      throw fail(
        'E_SKIN_INVALID',
        `皮肤必须是 64×64 的标准展开图，当前是 ${dim ? `${dim.width}×${dim.height}` : '未知尺寸'}`
      )
    }

    const fileName = `${id}.png`
    await fs.mkdir(this.paths.skinsDir, { recursive: true })
    await fs.writeFile(this.paths.skinFile(fileName), buf)

    const next = [...list]
    next[idx] = { ...next[idx], skinFile: fileName }
    await this.save(next)
    return next[idx]
  }

  /** 清除账号的自定义皮肤，回退到内置 Steve / Alex */
  async clearSkin(id: string): Promise<Account> {
    const list = await this.list()
    const idx = list.findIndex((a) => a.id === id)
    if (idx < 0) throw fail('E_ACCOUNT_MISSING', '账号不存在')
    const next = [...list]
    const { skinFile, ...rest } = next[idx]
    if (skinFile) {
      await fs.rm(this.paths.skinFile(skinFile), { force: true }).catch(() => {})
    }
    next[idx] = rest as Account
    await this.save(next)
    return next[idx]
  }

  /**
   * 读取账号皮肤，返回 data URL。
   *
   * 走 data URL 而不是 file://，避免 Electron 渲染进程的跨域限制。
   */
  async skinDataUrl(id: string): Promise<string | null> {
    const list = await this.list()
    const acc = list.find((a) => a.id === id)
    if (!acc?.skinFile) return null
    try {
      const buf = await fs.readFile(this.paths.skinFile(acc.skinFile))
      return `data:image/png;base64,${buf.toString('base64')}`
    } catch {
      return null
    }
  }

  async activate(id: string): Promise<Account> {
    const list = await this.list()
    const hit = list.find((a) => a.id === id)
    if (!hit) throw fail('E_ACCOUNT_MISSING', '账号不存在')
    await this.config.patch({ activeAccountId: id })
    return hit
  }

  async active(): Promise<Account | null> {
    const list = await this.list()
    if (!list.length) return null
    const cfg = await this.config.load()
    return list.find((a) => a.id === cfg.activeAccountId) ?? list[0]
  }

  private async save(list: Account[]): Promise<void> {
    this.cache = list
    const target = this.paths.accountsFile
    const tmp = `${target}.tmp`
    await fs.mkdir(this.paths.root, { recursive: true })
    await fs.writeFile(tmp, JSON.stringify(list, null, 2))
    await fs.rename(tmp, target)
  }
}
