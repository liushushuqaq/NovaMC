import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { GamePaths } from './paths'
import type { InstanceConfig, ModFile, ResPackFile } from './types'
import { fail } from './errors'

export class InstanceStore {
  private cache: InstanceConfig[] | null = null
  /** 每个实例一条写入队列，见 withLock() */
  private tails = new Map<string, Promise<unknown>>()
  private writeSeq = 0

  constructor(private readonly paths: GamePaths) {}

  async list(): Promise<InstanceConfig[]> {
    if (this.cache) return this.cache
    const result: InstanceConfig[] = []
    let dirs: string[] = []
    try {
      dirs = await fs.readdir(this.paths.instances)
    } catch {
      dirs = []
    }
    for (const dir of dirs) {
      try {
        const raw = await fs.readFile(path.join(this.paths.instances, dir, 'instance.json'), 'utf8')
        result.push(JSON.parse(raw) as InstanceConfig)
      } catch {
        /* 不是实例目录，跳过 */
      }
    }
    result.sort((a, b) => (b.lastPlayedAt ?? b.createdAt).localeCompare(a.lastPlayedAt ?? a.createdAt))
    this.cache = result
    return result
  }

  async get(id: string): Promise<InstanceConfig> {
    const list = await this.list()
    const hit = list.find((i) => i.id === id)
    if (!hit) throw fail('E_INSTANCE_NOT_FOUND', '实例不存在或已被删除')
    return hit
  }

  async create(input: Partial<InstanceConfig> & { name: string; gameVersion: string }): Promise<InstanceConfig> {
    const list = await this.list()
    const name = input.name.trim()
    if (!name) throw fail('E_INVALID_NAME', '实例名称不能为空')

    const slug = await this.uniqueSlug(name, list)
    const config: InstanceConfig = {
      id: crypto.randomUUID(),
      name,
      slug,
      createdAt: new Date().toISOString(),
      gameVersion: input.gameVersion,
      versionId: input.versionId ?? input.gameVersion,
      loader: input.loader ?? { kind: 'vanilla' },
      java: input.java ?? { mode: 'auto' },
      memory: input.memory ?? { minMb: 2048, maxMb: 8192 },
      window: input.window ?? { width: 1280, height: 720, fullscreen: false },
      jvmArgs: input.jvmArgs ?? [],
      gameArgs: input.gameArgs ?? [],
      source: input.source,
      verifyOnLaunch: input.verifyOnLaunch ?? true,
      importState: input.importState,
      background: input.background
    }

    await this.ensureGameLayout(slug)
    await this.write(config)
    this.cache = null
    return config
  }

  /**
   * 建好实例的标准目录。
   * shaderpacks / resourcepacks 必须预先存在：Minecraft 只有进过一次游戏才会自己建，
   * 在那之前「打开光影文件夹」只会得到一个"路径不存在"。
   */
  async ensureGameLayout(slug: string): Promise<void> {
    const gameDir = this.paths.instanceGameDir(slug)
    for (const sub of ['mods', 'shaderpacks', 'resourcepacks']) {
      await fs.mkdir(path.join(gameDir, sub), { recursive: true })
    }
  }

  async update(id: string, patch: Partial<InstanceConfig>): Promise<InstanceConfig> {
    return this.withLock(id, async () => {
      const current = await this.get(id)
      const next: InstanceConfig = {
        ...current,
        ...patch,
        id: current.id,
        slug: current.slug, // slug 是目录名，允许改名但不允许改目录
        name: patch.name?.trim() || current.name
      }
      await this.write(next)
      this.cache = null
      return next
    })
  }

  async remove(id: string, deleteFiles = true): Promise<void> {
    const inst = await this.get(id)
    if (deleteFiles) {
      await fs.rm(this.paths.instanceDir(inst.slug), { recursive: true, force: true })
    }
    this.cache = null
  }

  async touch(id: string): Promise<void> {
    await this.withLock(id, async () => {
      const inst = await this.get(id)
      inst.lastPlayedAt = new Date().toISOString()
      await this.write(inst)
      this.cache = null
    })
  }

  /** 写导入状态（undefined = 清掉，表示导入完成） */
  async setImportState(id: string, state: InstanceConfig['importState']): Promise<InstanceConfig> {
    return this.withLock(id, async () => {
      const inst = await this.get(id)
      if (state) inst.importState = state
      else delete inst.importState
      await this.write(inst)
      this.cache = null
      return inst
    })
  }

  /**
   * 启动时调用一次：上次退出时还在「导入中」的实例，其实已经被打断了。
   * 标成 interrupted，实例卡上给「重试 / 删除」，而不是一直转圈。
   */
  async reconcileImports(): Promise<number> {
    const list = await this.list()
    let changed = 0
    for (const inst of list) {
      if (inst.importState?.status !== 'importing') continue
      inst.importState = {
        ...inst.importState,
        status: 'interrupted',
        label: '导入被中断',
        error: '启动器已退出，导入没有跑完'
      }
      await this.withLock(inst.id, () => this.write(inst))
      changed++
    }
    if (changed) this.cache = null
    return changed
  }

  async mods(id: string): Promise<ModFile[]> {
    const inst = await this.get(id)
    const dir = path.join(this.paths.instanceGameDir(inst.slug), 'mods')
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const result: ModFile[] = []
    for (const name of names) {
      if (!name.endsWith('.jar') && !name.endsWith('.jar.disabled')) continue
      const full = path.join(dir, name)
      const stat = await fs.stat(full).catch(() => null)
      result.push({
        fileName: name,
        size: stat?.size ?? 0,
        enabled: name.endsWith('.jar')
      })
    }
    return result.sort((a, b) => a.fileName.localeCompare(b.fileName))
  }

  async toggleMod(id: string, fileName: string, enabled: boolean): Promise<void> {
    const inst = await this.get(id)
    const dir = path.join(this.paths.instanceGameDir(inst.slug), 'mods')
    const from = path.join(dir, enabled ? `${fileName}.disabled` : fileName)
    const to = path.join(dir, enabled ? fileName : `${fileName}.disabled`)
    try {
      await fs.rename(from, to)
    } catch {
      throw fail('E_MOD_TOGGLE', `无法切换 ${fileName} 的启用状态`)
    }
  }

  /**
   * 列出光影包（shaderpacks）或材质包（resourcepacks）。
   * 文件形态跟 mods 一样：`xxx.zip` / `xxx.jar` 是启用，`xxx.zip.disabled` 是停用。
   */
  async packages(id: string, kind: 'shader' | 'resource'): Promise<ResPackFile[]> {
    const inst = await this.get(id)
    const dir = path.join(this.paths.instanceGameDir(inst.slug), kind === 'shader' ? 'shaderpacks' : 'resourcepacks')
    // 老实例（在这次修复之前建的）没有这两个目录，先补出来再读
    await fs.mkdir(dir, { recursive: true }).catch(() => undefined)
    let names: string[] = []
    try {
      names = await fs.readdir(dir)
    } catch {
      return []
    }
    const result: ResPackFile[] = []
    for (const name of names) {
      const disabled = name.endsWith('.disabled')
      const base = disabled ? name.slice(0, -'.disabled'.length) : name
      if (!base.endsWith('.zip') && !base.endsWith('.jar')) continue
      const stat = await fs.stat(path.join(dir, name)).catch(() => null)
      result.push({
        fileName: name,
        size: stat?.size ?? 0,
        enabled: !disabled
      })
    }
    return result.sort((a, b) => a.fileName.localeCompare(b.fileName))
  }

  async togglePackage(id: string, kind: 'shader' | 'resource', fileName: string, enabled: boolean): Promise<void> {
    const inst = await this.get(id)
    const dir = path.join(this.paths.instanceGameDir(inst.slug), kind === 'shader' ? 'shaderpacks' : 'resourcepacks')
    const from = path.join(dir, enabled ? `${fileName}.disabled` : fileName)
    const to = path.join(dir, enabled ? fileName : `${fileName}.disabled`)
    try {
      await fs.rename(from, to)
    } catch {
      throw fail('E_PACK_TOGGLE', `无法切换 ${fileName} 的启用状态`)
    }
  }

  private async write(inst: InstanceConfig): Promise<void> {
    const dir = this.paths.instanceDir(inst.slug)
    await fs.mkdir(dir, { recursive: true })
    const target = path.join(dir, 'instance.json')
    // 即便有并发，tmp 名字也不会撞：撞了 rename 会 ENOENT
    const tmp = `${target}.${process.pid}.${this.writeSeq++}.tmp`
    await fs.writeFile(tmp, JSON.stringify(inst, null, 2))
    await fs.rename(tmp, target)
  }

  /**
   * 同一个实例的「读 → 改 → 写」必须串行。
   * 导入时进度是高频异步写的，两条链交叉会出现：后写的用旧快照覆盖新字段。
   */
  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    const tail = next.then(
      () => undefined,
      () => undefined
    )
    this.tails.set(key, tail)
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key)
    })
    return next
  }

  private async uniqueSlug(name: string, existing: InstanceConfig[]): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 32) || 'instance'
    let slug = base
    let n = 2
    const taken = new Set(existing.map((i) => i.slug))
    while (taken.has(slug)) slug = `${base}-${n++}`
    return slug
  }
}
