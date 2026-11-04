import path from 'node:path'
import fs from 'node:fs/promises'

/**
 * 所有落盘位置集中在这里。core 层不 import electron，根目录由主进程注入。
 */
export class GamePaths {
  constructor(public readonly root: string) {}

  get meta(): string {
    return path.join(this.root, 'meta')
  }
  get versions(): string {
    return path.join(this.root, 'versions')
  }
  get libraries(): string {
    return path.join(this.root, 'libraries')
  }
  get assets(): string {
    return path.join(this.root, 'assets')
  }
  get runtimes(): string {
    return path.join(this.root, 'runtime')
  }
  get instances(): string {
    return path.join(this.root, 'instances')
  }
  get configFile(): string {
    return path.join(this.root, 'config.json')
  }
  get accountsFile(): string {
    return path.join(this.root, 'accounts.json')
  }
  get logsDir(): string {
    return path.join(this.root, 'logs')
  }
  /** 账号自定义皮肤存放目录 */
  get skinsDir(): string {
    return path.join(this.root, 'skins')
  }

  versionDir(id: string): string {
    return path.join(this.versions, id)
  }
  versionJson(id: string): string {
    return path.join(this.versionDir(id), `${id}.json`)
  }
  versionJar(id: string): string {
    return path.join(this.versionDir(id), `${id}.jar`)
  }
  /** 安装成功后才写入的完成标记；中断的安装没有它，界面不会误报"已安装" */
  versionCompleteMark(id: string): string {
    return path.join(this.versionDir(id), '.novamc-complete')
  }
  library(mavenPath: string): string {
    return path.join(this.libraries, mavenPath)
  }
  assetIndex(id: string): string {
    return path.join(this.assets, 'indexes', `${id}.json`)
  }
  assetObject(hash: string): string {
    return path.join(this.assets, 'objects', hash.slice(0, 2), hash)
  }
  assetsVirtual(): string {
    return path.join(this.assets, 'virtual', 'legacy')
  }
  nativesDir(scopeId: string): string {
    return path.join(this.root, 'natives', scopeId)
  }
  instanceDir(slug: string): string {
    return path.join(this.instances, slug)
  }
  instanceGameDir(slug: string): string {
    return path.join(this.instances, slug, '.minecraft')
  }
  instanceFile(slug: string): string {
    return path.join(this.instances, slug, 'instance.json')
  }

  async ensure(): Promise<void> {
    await Promise.all(
      [
        this.root,
        this.meta,
        this.versions,
        this.libraries,
        this.assets,
        this.runtimes,
        this.instances,
        this.logsDir,
        this.skinsDir
      ].map((d) => fs.mkdir(d, { recursive: true }))
    )
  }

  /** 账号自定义皮肤文件 */
  skinFile(name: string): string {
    return path.join(this.skinsDir, name)
  }

  /** 把 "group:artifact:version[:classifier]" 转成 maven 目录结构 */
  static mavenToPath(name: string): string {
    const [group, artifact, version, classifier] = name.split(':')
    const file = classifier ? `${artifact}-${version}-${classifier}.jar` : `${artifact}-${version}.jar`
    return `${group.replace(/\./g, '/')}/${artifact}/${version}/${file}`
  }
}

export interface PlatformInfo {
  name: 'windows' | 'osx' | 'linux'
  arch: 'x64' | 'arm64' | 'x86'
  version: string
}

export function detectPlatform(): PlatformInfo {
  const name: PlatformInfo['name'] =
    process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'osx' : 'linux'
  const arch = process.arch === 'arm64' ? 'arm64' : process.arch === 'ia32' ? 'x86' : 'x64'
  return { name, arch, version: process.getSystemVersion?.() ?? '' }
}

export async function moveToTrash(target: string): Promise<void> {
  await fs.rm(target, { recursive: true, force: true })
}
