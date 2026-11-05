import { contextBridge, ipcRenderer } from 'electron'
import type { NovaApi } from '../core/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> => ipcRenderer.invoke(channel, ...args) as Promise<T>

const api: NovaApi & {
  win: {
    minimize(): Promise<void>
    toggleMaximize(): Promise<void>
    close(): Promise<void>
  }
} = {
  config: {
    get: () => invoke('config:get'),
    patch: (patch) => invoke('config:patch', patch),
    reset: () => invoke('config:reset')
  },
  versions: {
    list: (force) => invoke('versions:list', force),
    installed: () => invoke('versions:installed'),
    install: (id) => invoke('versions:install', id),
    installFabric: (gameVersion, loaderVersion) => invoke('versions:installFabric', gameVersion, loaderVersion),
    listForge: (family, mcVersion) => invoke('versions:listForge', family, mcVersion),
    installForge: (family, loaderVersion) => invoke('versions:installForge', family, loaderVersion),
    remove: (id) => invoke('versions:remove', id)
  },
  instances: {
    list: () => invoke('instances:list'),
    create: (input) => invoke('instances:create', input),
    update: (id, patch) => invoke('instances:update', id, patch),
    remove: (id) => invoke('instances:remove', id),
    mods: (id) => invoke('instances:mods', id),
    toggleMod: (id, fileName, enabled) => invoke('instances:toggleMod', id, fileName, enabled),
    packages: (id, kind) => invoke('instances:packages', id, kind),
    togglePackage: (id, kind, fileName, enabled) => invoke('instances:togglePackage', id, kind, fileName, enabled),
    openPackDir: (id, kind) => invoke('instances:openPackDir', id, kind),
    checkDeps: (id) => invoke('instances:checkDeps', id),
    fixDeps: (id) => invoke('instances:fixDeps', id),
    pickBackground: (id) => invoke('instances:pickBackground', id),
    autoBackground: (id) => invoke('instances:autoBackground', id),
    clearBackground: (id) => invoke('instances:clearBackground', id),
    background: (id) => invoke('instances:background', id)
  },
  launch: {
    start: (instanceId) => invoke('launch:start', instanceId),
    kill: () => invoke('launch:kill'),
    running: () => invoke('launch:running')
  },
  auth: {
    list: () => invoke('auth:list'),
    addOffline: (name, skinModel) => invoke('auth:addOffline', name, skinModel),
    remove: (id) => invoke('auth:remove', id),
    activate: (id) => invoke('auth:activate', id),
    setSkin: (id) => invoke('auth:setSkin', id),
    clearSkin: (id) => invoke('auth:clearSkin', id),
    skinDataUrl: (id) => invoke('auth:skinDataUrl', id)
  },
  java: {
    detect: () => invoke('java:detect'),
    provision: (major) => invoke('java:provision', major)
  },
  modpack: {
    search: (query, gameVersion) => invoke('modpack:search', query, gameVersion),
    install: (projectId, instanceName) => invoke('modpack:install', projectId, instanceName),
    pickZip: () => invoke('modpack:pickZip'),
    importZip: (zipPath, instanceName) => invoke('modpack:importZip', zipPath, instanceName),
    cancelImport: (instanceId) => invoke('modpack:cancelImport', instanceId),
    retryImport: (instanceId) => invoke('modpack:retryImport', instanceId)
  },
  shader: {
    supports: (id) => invoke('shader:supports', id),
    plan: (id) => invoke('shader:plan', id),
    status: (id) => invoke('shader:status', id),
    install: (id) => invoke('shader:install', id),
    installLocal: (id) => invoke('shader:installLocal', id)
  },
  tunnel: {
    list: (provider, token) => invoke('tunnel:list', provider, token),
    account: (provider, token) => invoke('tunnel:account', provider, token),
    start: (provider, token, tunnel) => invoke('tunnel:start', provider, token, tunnel),
    stop: () => invoke('tunnel:stop'),
    status: () => invoke('tunnel:status')
  },
  system: {
    openPath: (target) => invoke('system:openPath', target),
    paths: () => invoke('system:paths'),
    pickJava: () => invoke('system:pickJava'),
    logs: () => invoke('system:logs'),
    storage: (force) => invoke('system:storage', force),
    info: () => invoke('system:info'),
    clearLogs: () => invoke('system:clearLogs')
  },
  update: {
    check: () => invoke('update:check'),
    download: () => invoke('update:download'),
    install: () => invoke('update:install'),
    openReleases: () => invoke('update:openReleases'),
    openSource: () => invoke('update:openSource'),
    cancel: () => invoke('update:cancel')
  },
  events: {
    onProgress: (cb) => subscribe('task:progress', cb),
    onLog: (cb) => subscribe('game:log', cb),
    onExit: (cb) => subscribe('game:exit', cb),
    onTheme: (cb) => subscribe('theme:change', cb),
    onImport: (cb) => subscribe('import:progress', cb),
    onUpdate: (cb) => subscribe('update:progress', cb)
  },
  win: {
    minimize: () => invoke('win:minimize'),
    toggleMaximize: () => invoke('win:toggleMaximize'),
    close: () => invoke('win:close')
  }
}

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('nova', api)
