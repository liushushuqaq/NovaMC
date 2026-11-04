import type { MirrorMode } from './types'

const OFFICIAL_MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
const BMCL_MANIFEST = 'https://bmclapi2.bangbang93.com/mc/game/version_manifest_v2.json'
const BMCL = 'https://bmclapi2.bangbang93.com'

export interface MirrorConfig {
  mode: MirrorMode
}

export function manifestUrl(mode: MirrorMode): { primary: string; mirrors: string[] } {
  if (mode === 'bmclapi') return { primary: BMCL_MANIFEST, mirrors: [OFFICIAL_MANIFEST] }
  if (mode === 'official') return { primary: OFFICIAL_MANIFEST, mirrors: [] }
  return { primary: OFFICIAL_MANIFEST, mirrors: [BMCL_MANIFEST] }
}

/** 版本 JSON 有官方 CDN 与 BMCLAPI 两套地址，后者需要 version id 才能拼 */
export function versionJsonUrls(id: string, officialUrl: string, mode: MirrorMode): { primary: string; mirrors: string[] } {
  const bmcl = `${BMCL}/version/${id}/json`
  if (mode === 'bmclapi') return { primary: bmcl, mirrors: [officialUrl] }
  if (mode === 'official') return { primary: officialUrl, mirrors: [] }
  return { primary: officialUrl, mirrors: [bmcl] }
}

export function libraryUrls(mavenPath: string, officialUrl: string | undefined, mode: MirrorMode): { primary: string; mirrors: string[] } {
  const official = officialUrl ?? `https://libraries.minecraft.net/${mavenPath}`
  const bmcl = `${BMCL}/maven/${mavenPath}`
  if (mode === 'bmclapi') return { primary: bmcl, mirrors: [official] }
  if (mode === 'official') return { primary: official, mirrors: [] }
  return { primary: official, mirrors: [bmcl] }
}

export function assetUrls(hash: string, mode: MirrorMode): { primary: string; mirrors: string[] } {
  const ab = hash.slice(0, 2)
  const official = `https://resources.download.minecraft.net/${ab}/${hash}`
  const bmcl = `${BMCL}/assets/${ab}/${hash}`
  if (mode === 'bmclapi') return { primary: bmcl, mirrors: [official] }
  if (mode === 'official') return { primary: official, mirrors: [] }
  return { primary: official, mirrors: [bmcl] }
}

export function clientJarUrls(id: string, officialUrl: string, mode: MirrorMode): { primary: string; mirrors: string[] } {
  const bmcl = `${BMCL}/version/${id}/client`
  if (mode === 'bmclapi') return { primary: bmcl, mirrors: [officialUrl] }
  if (mode === 'official') return { primary: officialUrl, mirrors: [] }
  return { primary: officialUrl, mirrors: [bmcl] }
}

/**
 * Fabric 的 meta 服务（加载器列表、profile）也可能连不上。
 * BMCLAPI 有对应的 /fabric-meta 通道，按镜像模式决定先后顺序。
 */
export function fabricMetaUrls(pathname: string, mode: MirrorMode): { primary: string; mirrors: string[] } {
  const official = `https://meta.fabricmc.net/${pathname}`
  const bmcl = `https://bmclapi2.bangbang93.com/fabric-meta/${pathname}`
  if (mode === 'bmclapi') return { primary: bmcl, mirrors: [official] }
  if (mode === 'official') return { primary: official, mirrors: [] }
  return { primary: official, mirrors: [bmcl] }
}
