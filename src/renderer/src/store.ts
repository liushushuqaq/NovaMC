import { create } from 'zustand'
import type {
  Account,
  AppConfig,
  ImportProgress,
  InstalledVersionInfo,
  InstanceConfig,
  Result,
  TaskProgress,
  VersionManifest
} from '@core/types'

export type PageKey = 'home' | 'versions' | 'instances' | 'modpacks' | 'accounts' | 'tunnel' | 'settings'

export interface ToastItem {
  id: string
  kind: 'info' | 'success' | 'warn' | 'error'
  title: string
  body?: string
}

interface AppState {
  ready: boolean
  config: AppConfig | null
  manifest: VersionManifest | null
  installed: InstalledVersionInfo[]
  instances: InstanceConfig[]
  accounts: Account[]
  progress: TaskProgress[]
  /** 整合包导入的实时进度，key = 实例 ID */
  imports: Record<string, ImportProgress>
  /** 实例卡片背景图（data URL），key = 实例 ID；没有就是渐变色 */
  backgrounds: Record<string, string>
  toasts: ToastItem[]
  logs: string[]
  running: string | null
  page: PageKey

  init(): Promise<void>
  reload(): Promise<void>
  setPage(page: PageKey): void
  patchConfig(patch: Partial<AppConfig>): Promise<void>
  notify(kind: ToastItem['kind'], title: string, body?: string): void
  dismiss(id: string): void
  clearProgress(taskId: string): void
}

let toastSeq = 0

/** 统一处理 Result：失败直接弹 toast，调用方只关心成功分支 */
async function unwrap<T>(fn: () => Promise<Result<T>>, notify: (t: ToastItem) => void, title = '操作失败'): Promise<T | null> {
  try {
    const res = await fn()
    if (res.ok) return res.data
    notify({ id: `t${toastSeq++}`, kind: 'error', title, body: res.message })
    return null
  } catch (e) {
    notify({ id: `t${toastSeq++}`, kind: 'error', title, body: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export const useApp = create<AppState>((set, get) => ({
  ready: false,
  config: null,
  manifest: null,
  installed: [],
  instances: [],
  accounts: [],
  progress: [],
  imports: {},
  backgrounds: {},
  toasts: [],
  logs: [],
  running: null,
  page: 'home',

  async init() {
    const notify = (t: ToastItem) => set((s) => ({ toasts: [...s.toasts, t] }))

    window.nova.events.onProgress((p) => {
      set((s) => ({
        progress: [p, ...s.progress.filter((x) => x.taskId !== p.taskId)].slice(0, 4)
      }))
      if (p.error) {
        notify({ id: `t${toastSeq++}`, kind: 'error', title: p.title, body: p.error.message })
      } else if (p.stage === 'done' && p.title.startsWith('安装 ') && !p.title.includes('Java')) {
        // 用户可能已经切到别的页面，装完给个明确回执
        notify({
          id: `t${toastSeq++}`,
          kind: p.label ? 'warn' : 'success',
          title: p.title,
          body: p.label || '安装完成，可以启动了'
        })
      }
      // 完成/失败的任务不要一直占着侧边栏，留几秒让人看清结果就走
      if (p.stage === 'done') {
        setTimeout(
          () => set((s) => ({ progress: s.progress.filter((x) => x.taskId !== p.taskId) })),
          p.error ? 12_000 : 5_000
        )
      }
    })
    window.nova.events.onLog((line) => {
      set((s) => ({ logs: [...s.logs.slice(-400), line] }))
    })
    // 整合包导入：边跑边更新「导入中」的卡片和导入面板
    window.nova.events.onImport((p) => {
      set((s) => ({ imports: { ...s.imports, [p.instanceId]: p } }))
      if (p.stage !== 'done') return
      if (p.cancelled) {
        notify({ id: `t${toastSeq++}`, kind: 'warn', title: '已取消导入', body: '半成品实例已经清掉了' })
        void get().reload()
        return
      }
      if (p.error) {
        notify({ id: `t${toastSeq++}`, kind: 'error', title: '导入失败', body: p.error })
        void get().reload()
        return
      }
      notify({ id: `t${toastSeq++}`, kind: p.label.startsWith('完成，') ? 'warn' : 'success', title: '整合包已导入', body: p.label })
      void get().reload()
    })
    window.nova.events.onExit(({ code, crashLog }) => {
      set({ running: null })
      if (code !== 0) {
        notify({
          id: `t${toastSeq++}`,
          kind: 'error',
          title: `游戏异常退出（code ${code}）`,
          body: crashLog?.split('\n').slice(-3).join('\n')
        })
      }
    })

    const config = await unwrap(() => window.nova.config.get(), notify, '读取配置失败')
    const installed = await unwrap(() => window.nova.versions.installed(), notify)
    const instances = await unwrap(() => window.nova.instances.list(), notify)
    const accounts = await unwrap(() => window.nova.auth.list(), notify)
    const running = await unwrap(() => window.nova.launch.running(), notify)

    // 首帧不阻塞在网络请求上：清单在后台拉，拉到再刷新
    set({
      ready: true,
      config,
      installed: installed ?? [],
      instances: instances ?? [],
      accounts: accounts ?? [],
      running: running ?? null
    })

    void loadBackgrounds(instances ?? []).then((backgrounds) => set({ backgrounds }))

    void window.nova.versions.list(false).then((res) => {
      if (res.ok) set({ manifest: res.data })
    })
  },

  async reload() {
    const notify = (t: ToastItem) => set((s) => ({ toasts: [...s.toasts, t] }))
    const [installed, instances, accounts, config, manifest] = await Promise.all([
      unwrap(() => window.nova.versions.installed(), notify),
      unwrap(() => window.nova.instances.list(), notify),
      unwrap(() => window.nova.auth.list(), notify),
      unwrap(() => window.nova.config.get(), notify),
      unwrap(() => window.nova.versions.list(false), notify)
    ])
    set({
      installed: installed ?? get().installed,
      instances: instances ?? get().instances,
      accounts: accounts ?? get().accounts,
      config: config ?? get().config,
      manifest: manifest ?? get().manifest
    })

    // 背景图跟着实例一起刷：卡片和 hero 都用这份缓存，别各自去读文件
    set({ backgrounds: await loadBackgrounds(instances ?? get().instances) })
  },

  setPage(page) {
    set({ page })
  },

  async patchConfig(patch) {
    const notify = (t: ToastItem) => set((s) => ({ toasts: [...s.toasts, t] }))
    const next = await unwrap(() => window.nova.config.patch(patch), notify, '保存设置失败')
    if (next) set({ config: next })
  },

  notify(kind, title, body) {
    set((s) => ({ toasts: [...s.toasts, { id: `t${toastSeq++}`, kind, title, body }] }))
  },

  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
  },

  clearProgress(taskId) {
    set((s) => ({ progress: s.progress.filter((p) => p.taskId !== taskId) }))
  }
}))

/** 批量读实例背景图（data URL）。没有背景的实例不会出现在结果里 */
async function loadBackgrounds(list: InstanceConfig[]): Promise<Record<string, string>> {
  const withBg = list.filter((i) => i.background)
  if (!withBg.length) return {}
  const entries = await Promise.all(
    withBg.map(async (i) => {
      const res = await window.nova.instances.background(i.id).catch(() => null)
      return [i.id, res?.ok ? res.data : null] as const
    })
  )
  const out: Record<string, string> = {}
  for (const [id, url] of entries) if (url) out[id] = url
  return out
}

/** 供页面复用的结果处理 */
export async function invoke<T>(fn: () => Promise<Result<T>>, title = '操作失败'): Promise<T | null> {
  try {
    const res = await fn()
    if (res.ok) return res.data
    useApp.getState().notify('error', title, res.message)
    return null
  } catch (e) {
    useApp.getState().notify('error', title, e instanceof Error ? e.message : String(e))
    return null
  }
}
